/**
 * Connectivity smoke test to run right after keys are added to .env:
 * TTS (en-IN voice) → STT + pronunciation assessment on that audio → LLM JSON turn → Content Safety.
 */
import pino from 'pino';
import type { Env } from '../src/config/env.js';
import { AzureTts } from '../src/providers/tts/azureTts.js';
import { AzureSpeechRecognizer } from '../src/providers/speech/azureRecognizer.js';
import { AzureOpenAiLlm } from '../src/providers/llm/azureOpenAi.js';
import { AzureContentSafety } from '../src/providers/safety/azureContentSafety.js';
import { TUTOR_JSON_SCHEMA, parseTutorOutput } from '../src/domain/tutor/schema.js';
import { buildSystemPrompt } from '../src/domain/tutor/prompts.js';

export async function smoke(env: Env) {
  const log = pino({ level: 'warn' });
  const report: Record<string, unknown> = {};

  // 1. TTS straight to 16 kHz PCM so the same audio can be fed back into STT.
  const tts = new AzureTts({ ...env, TTS_OUTPUT_FORMAT: 'pcm16' });
  let t = Date.now();
  const pcm16 = await tts.synthesize({ text: 'I think the school bus is very late today.', role: 'conversation' });
  tts.close();
  report.tts = { ok: pcm16.length > 0, bytes: pcm16.length, ms: Date.now() - t, voice: env.TTS_VOICE_CONVERSATION };

  // 2. STT + dual pronunciation assessment
  const rec = new AzureSpeechRecognizer(env, log, 0);
  t = Date.now();
  const stream = await rec.start({ segmentationSilenceMs: 600, phrases: [], prosody: true }, { onPartial() {}, onSegment() {}, onError: (e) => (report.stt_error = e.message) });
  for (let i = 0; i < pcm16.length; i += 3200) stream.write(pcm16.subarray(i, i + 3200));
  stream.write(Buffer.alloc(16_000 * 2)); // 1 s of silence to finalise
  const a = await stream.finish();
  report.stt = {
    ok: a.text.length > 0,
    text: a.text,
    scoring_locale: a.scoringLocale,
    phoneme_names_present: a.words.some((w) => w.phonemes.some((p) => p.p)),
    nbest_heard_present: a.words.some((w) => w.phonemes.some((p) => p.heard)),
    prosody: a.scores.prosody,
    ms: Date.now() - t,
  };

  // 3. LLM streaming structured output
  const llm = new AzureOpenAiLlm(env);
  t = Date.now();
  let first = 0;
  const res = await llm.streamJson(
    {
      messages: [
        { role: 'system', content: buildSystemPrompt({ cefr: 'A2', l1: 'hi', ageBand: 'adult', mode: 'tutor', topErrors: 'none yet' }) },
        { role: 'user', content: 'Transcript: "Yesterday I go to the market"\nPronunciation word to coach: none\nFluency: 80, Completeness: 100, Long pauses: 0' },
      ],
      schema: TUTOR_JSON_SCHEMA,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      tier: 'tutor',
    },
    () => (first ||= Date.now()),
  );
  report.llm = { ok: Boolean(parseTutorOutput(res.text, null)), ttft_ms: first - t, total_ms: Date.now() - t, usage: res.usage, deployment: env.AZURE_OPENAI_TUTOR_DEPLOYMENT };

  // 4. Content Safety
  if (env.AZURE_CONTENT_SAFETY_ENDPOINT) {
    const cs = new AzureContentSafety(env, log);
    t = Date.now();
    const v = await cs.checkInput('I love playing cricket with my friends', 'kid');
    report.content_safety = { ok: v.allowed, ms: Date.now() - t };
  }
  return report;
}
