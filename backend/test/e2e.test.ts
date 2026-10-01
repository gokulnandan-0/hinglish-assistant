/**
 * End-to-end turn flow over a real WebSocket, PostgreSQL and Redis, with fake Azure providers.
 * Requires `docker compose up -d` (skipped automatically when the databases are unreachable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { Redis } from 'ioredis';
import pino from 'pino';
import WebSocket from 'ws';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedScenarios } from '../src/db/seed.js';
import { Repo } from '../src/db/repo.js';
import { SessionState } from '../src/lib/sessionState.js';
import { loadPronunciationPolicy } from '../src/domain/pronunciation/policy.js';
import { createVerifier } from '../src/auth/jwt.js';
import { buildServer } from '../src/server.js';
import { TtsCache } from '../src/providers/tts/ttsCache.js';
import { DisabledAudioStore } from '../src/providers/storage/audioStore.js';
import type { Deps } from '../src/deps.js';
import type { UtteranceAssessment } from '../src/domain/types.js';
import type { SpeechRecognizerProvider } from '../src/providers/speech/types.js';
import type { LlmProvider } from '../src/providers/llm/types.js';
import type { SafetyProvider } from '../src/providers/safety/types.js';

const SECRET = 'test-secret-test-secret-1234';
const env = loadEnv({
  NODE_ENV: 'test',
  AUTH_DEV_SECRET: SECRET,
  AZURE_SPEECH_KEY: 'fake',
  AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://nova:nova@localhost:5433/nova',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_TURNS_PER_MIN: '100',
});

// ---- fakes -------------------------------------------------------------------------------------

const assessments: UtteranceAssessment[] = [];
const fakeSpeech: SpeechRecognizerProvider & { lastReference?: string } = {
  async start(opts, events) {
    fakeSpeech.lastReference = opts.referenceText;
    let partialSent = false;
    return {
      write() {
        if (!partialSent) events.onPartial('I go');
        partialSent = true;
      },
      async finish() {
        return assessments.shift()!;
      },
      cancel() {},
    };
  },
};

const llmReplies: object[] = [];
const fakeLlm: LlmProvider = {
  async streamJson(req, onDelta) {
    if (req.tier === 'summary') {
      const text = JSON.stringify({ well_done: ['You spoke clearly'], fix_next: ['past tense'], new_phrases: ['I went'] });
      onDelta(text);
      return { text, usage: null, filtered: false, finishReason: 'stop' };
    }
    const text = JSON.stringify(llmReplies.shift());
    for (let i = 0; i < text.length; i += 5) {
      onDelta(text.slice(i, i + 5));
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    return { text, usage: { inputTokens: 900, outputTokens: 80, cachedInputTokens: 600 }, filtered: false, finishReason: 'stop' };
  },
};

const fakeSafety: SafetyProvider = {
  async checkInput(text) {
    const selfHarm = /hurt myself/i.test(text);
    return { allowed: !selfHarm, category: selfHarm ? 'SelfHarm' : null, severity: selfHarm ? 4 : 0, escalate: selfHarm };
  },
  async checkOutput() {
    return { allowed: true, category: null, severity: 0, escalate: false };
  },
};

const createTts = () => ({
  outputFormat: { mime: 'audio/ogg; codecs=opus', sampleRate: 24000, name: 'ogg-opus' },
  async synthesizeStream(req: { text: string }, onChunk: (c: Buffer) => void) {
    onChunk(Buffer.from(`AUDIO(${req.text.slice(0, 10)})`));
  },
  async synthesize(req: { text: string }) {
    return Buffer.from(`CLIP(${req.text})`);
  },
  close() {},
});

const assessment = (text: string, words: UtteranceAssessment['words']): UtteranceAssessment => ({
  text,
  words,
  scores: { accuracy: 70, fluency: 65, completeness: 100, prosody: 60, pronunciation: 68 },
  longPauses: 0,
  durationMs: 2500,
  scoringLocale: 'en-IN+en-US',
});

// ---- harness -----------------------------------------------------------------------------------

let db: ReturnType<typeof createPool>;
let redis: Redis;
let baseUrl = '';
let app: Awaited<ReturnType<typeof buildServer>>;
db = createPool(env);
redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const available = await Promise.all([db.query('SELECT 1'), redis.connect()]).then(
  () => true,
  (err) => {
    console.warn(`e2e skipped: databases unreachable (${err.message}). Run: docker compose up -d`);
    return false;
  },
);

beforeAll(async () => {
  if (!available) return;
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await migrate(db);
  await seedScenarios(db);
  const log = pino({ level: process.env.E2E_LOG ?? 'silent' });
  const deps: Deps = {
    env,
    log,
    db,
    redis,
    repo: new Repo(db),
    state: new SessionState(redis),
    policy: loadPronunciationPolicy(),
    pricing: { sttPerAudioHour: 1, ttsPerMillionChars: 15, llm: { tutor: { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 }, kids: { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 }, summary: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 } } },
    speech: fakeSpeech,
    createTts,
    ttsCache: new TtsCache(redis, createTts, (r) => r.role, 'ogg-opus'),
    ttsMime: 'audio/ogg; codecs=opus',
    llm: fakeLlm,
    safety: fakeSafety,
    audioStore: new DisabledAudioStore(),
    verify: createVerifier(env),
  };
  app = await buildServer(deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  redis?.disconnect();
});

const token = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));

async function api(method: string, path: string, sub: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(sub)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
}

class Client {
  messages: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  static async open(sessionId: string, sub: string) {
    const ws = new WebSocket(`ws://${baseUrl}/v1/sessions/${sessionId}/stream?access_token=${await token(sub)}`);
    const c = new Client(ws);
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    return c;
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      this.waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`timeout; got ${this.messages.map((m) => m.type).join(',')}`)), timeoutMs);
    });
  }
  since(i: number) {
    return this.messages.slice(i);
  }
}

const pcm = () => Buffer.alloc(3200).toString('base64');

describe.runIf(available)('e2e turn pipeline', () => {
  it('rejects minors without verifiable parental consent', async () => {
    const r = await api('POST', '/v1/learners', 'kid-1', { age_band: 'kid', l1: 'ta', consent: { parental: true } });
    expect(r.status).toBe(422);
  });

  it('runs a full tutor turn: transcript, highlights, streamed audio, feedback, persistence', async () => {
    const learner = await api('POST', '/v1/learners', 'adult-1', { age_band: 'adult', l1: 'hi', level: 'A2', display_name: 'Ravi', consent: { audio_storage: false } });
    expect(learner.status).toBe(201);
    const session = await api('POST', '/v1/sessions', 'adult-1', { mode: 'tutor' });
    expect(session.status).toBe(201);

    const c = await Client.open(session.body.id, 'adult-1');
    await c.waitFor((m) => m.type === 'ready');
    await c.waitFor((m) => m.type === 'reply_text' && /Nova/.test(m.text)); // greeting

    assessments.push(
      assessment('I go to see sheep yesterday', [
        { w: 'I', score: 95, error: 'None', phonemes: [] },
        { w: 'go', score: 90, error: 'None', phonemes: [] },
        { w: 'to', score: 60, error: 'None', phonemes: [{ p: 't', score: 30, heard: 'ʈ' }, { p: 'u', score: 90 }] },
        { w: 'see', score: 88, error: 'None', phonemes: [] },
        { w: 'sheep', score: 42, error: 'Mispronunciation', phonemes: [{ p: 'ʃ', score: 90 }, { p: 'i', score: 22, heard: 'ɪ' }, { p: 'p', score: 90 }] },
        { w: 'yesterday', score: 85, error: 'None', phonemes: [] },
      ]),
    );
    llmReplies.push({
      safety_flag: 'none',
      correction: { original: 'I go', fixed: 'I went', why: 'Yesterday is past, so we use "went".', key: 'grammar:past_simple' },
      reply: 'Lovely, you saw sheep! For yesterday we say "I went". Where did you see them?',
      pron_tip: { word: 'sheep', tip: 'Make the ee long: sheeep.' },
      next_prompt: 'Where did you see them?',
      practised_correctly: [],
      scene_complete: false,
    });

    const mark = c.messages.length;
    c.send({ type: 'audio', data: pcm() });
    c.send({ type: 'audio', data: pcm() });
    c.send({ type: 'end_utterance' });
    const end = await c.waitFor((m) => m.type === 'turn_end');
    const turn = c.since(mark);
    const types = turn.map((m) => m.type);

    expect(types).toContain('partial_transcript');
    const final = turn.find((m) => m.type === 'final_transcript');
    expect(final.words.find((w: any) => w.w === 'sheep').highlight).toBe(true);
    expect(final.words.find((w: any) => w.w === 'to').highlight).toBe(false); // retroflex /t/ accepted
    expect(final.scores_are_estimates).toBe(true);

    // Audio streamed per sentence, before the final feedback payload.
    const firstAudio = types.indexOf('audio');
    expect(firstAudio).toBeGreaterThan(-1);
    expect(firstAudio).toBeLessThan(types.indexOf('feedback'));
    expect(turn.filter((m) => m.type === 'reply_text').length).toBeGreaterThanOrEqual(2);
    expect(turn.filter((m) => m.type === 'audio').at(-1).last).toBe(true);

    const fb = turn.find((m) => m.type === 'feedback');
    expect(fb.correction.fixed).toBe('I went');
    expect(fb.pron_tip.word).toBe('sheep');
    expect(await c.waitFor((m) => m.type === 'model_audio')).toMatchObject({ text: 'sheep' });
    expect(end.latency_ms.first_audio).toBeGreaterThanOrEqual(0);

    const profile = await api('GET', `/v1/learners/${learner.body.id}/profile`, 'adult-1');
    const keys = profile.body.top_errors.map((e: any) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['grammar:past_simple', 'phoneme:i-ɪ']));
    expect(profile.body.streak_days).toBe(1);

    // ---- coaching loop: learner repeats the word as a scripted drill and passes
    c.send({ type: 'set_reference', text: 'sheep' });
    await c.waitFor((m) => m.type === 'model_audio' && c.messages.filter((x) => x.type === 'model_audio').length >= 2);
    assessments.push(assessment('sheep', [{ w: 'sheep', score: 82, error: 'None', phonemes: [{ p: 'i', score: 80 }] }]));
    llmReplies.push({ safety_flag: 'none', correction: null, reply: 'Yes! That long ee sound was perfect. Let us keep talking.', pron_tip: null, next_prompt: 'Let us keep talking.', practised_correctly: [], scene_complete: false });
    const mark2 = c.messages.length;
    c.send({ type: 'audio', data: pcm() });
    c.send({ type: 'end_utterance' });
    await c.waitFor((m) => m.type === 'turn_end' && c.messages.indexOf(m) >= mark2);
    expect(fakeSpeech.lastReference).toBe('sheep');
    const drillFb = c.since(mark2).find((m) => m.type === 'feedback');
    expect(drillFb.drill).toMatchObject({ passed: true, done: true, attempt: 1 });

    // ---- escalation: self-harm content is never answered by the model's reply
    assessments.push(assessment('I want to hurt myself', [{ w: 'hurt', score: 90, error: 'None', phonemes: [] }]));
    llmReplies.push({ safety_flag: 'self_harm', correction: null, reply: 'MODEL REPLY SHOULD NOT PLAY.', pron_tip: null, next_prompt: '', practised_correctly: [], scene_complete: false });
    const mark3 = c.messages.length;
    c.send({ type: 'audio', data: pcm() });
    c.send({ type: 'end_utterance' });
    await c.waitFor((m) => m.type === 'turn_end' && c.messages.indexOf(m) >= mark3);
    const esc = c.since(mark3);
    expect(esc.find((m) => m.type === 'feedback').safety.escalation).toBe(true);
    expect(esc.filter((m) => m.type === 'reply_text').map((m) => m.text).join(' ')).toMatch(/14416/);
    expect(esc.some((m) => m.type === 'reply_text' && /SHOULD NOT PLAY/.test(m.text))).toBe(false);

    // ---- end session → summary
    c.send({ type: 'end_session' });
    const summary = await c.waitFor((m) => m.type === 'session_summary');
    expect(summary.summary.fixNext).toContain('past tense');
    const stored = await api('GET', `/v1/sessions/${session.body.id}/summary`, 'adult-1');
    expect(stored.body.summary.stats.turns).toBe(3);
  });

  it('role-play: opening line, scene completion ends the session with a summary', async () => {
    await api('POST', '/v1/learners', 'adult-3', { age_band: 'adult', l1: 'bn', level: 'A2', consent: {} });
    const session = await api('POST', '/v1/sessions', 'adult-3', { mode: 'roleplay', scenario_id: 'railway-enquiry' });
    expect(session.status).toBe(201);
    const c = await Client.open(session.body.id, 'adult-3');
    await c.waitFor((m) => m.type === 'reply_text' && /Enquiry counter/.test(m.text));
    assessments.push(assessment('Which platform for the Chennai express please', [{ w: 'platform', score: 88, error: 'None', phonemes: [] }]));
    llmReplies.push({ safety_flag: 'none', correction: null, reply: 'Platform four, sir. It leaves at 6:15. Have a good journey!', pron_tip: null, next_prompt: '', practised_correctly: [], scene_complete: true });
    c.send({ type: 'audio', data: pcm() });
    c.send({ type: 'end_utterance' });
    const summary = await c.waitFor((m) => m.type === 'session_summary');
    expect(summary.summary.stats.turns).toBe(1);
    const stored = await api('GET', `/v1/sessions/${session.body.id}/summary`, 'adult-3');
    expect(stored.body.ended_at).not.toBeNull();
    c.ws.close();
  });

  it('isolates learners and supports DPDP deletion', async () => {
    const other = await api('POST', '/v1/learners', 'adult-2', { age_band: 'adult', l1: 'ta', consent: {} });
    expect((await api('GET', `/v1/learners/${other.body.id}/profile`, 'adult-1')).status).toBe(404);
    const del = await api('DELETE', `/v1/learners/${other.body.id}/data`, 'adult-2');
    expect(del.status).toBe(202);
    expect((await api('GET', `/v1/learners/${other.body.id}/profile`, 'adult-2')).status).toBe(404);
  });

  it('filters scenarios by audience', async () => {
    const r = await api('GET', '/v1/scenarios', 'adult-1');
    const ids = r.body.map((s: any) => s.id);
    expect(ids).toContain('job-interview-hr');
    expect(ids).not.toContain('school-friend');
  });
});
