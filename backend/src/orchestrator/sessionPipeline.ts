import type { Deps } from '../deps.js';
import type { Cefr, ErrorProfileItem, Learner, Scenario, Session, TutorOutput, UtteranceAssessment } from '../domain/types.js';
import { describeFocus, selectPronunciationFocus, thresholdFor, type SelectorResult } from '../domain/pronunciation/selector.js';
import { deriveObservations, formatTopErrors, topErrors, updateMastery, INITIAL_MASTERY } from '../domain/profile/mastery.js';
import { TopLevelJsonStream } from '../domain/tutor/jsonStream.js';
import { SentenceSplitter } from '../domain/tutor/sentenceSplitter.js';
import { buildSystemPrompt, buildTurnInput, PROMPT_VERSION } from '../domain/tutor/prompts.js';
import { fallbackOutput, parseTutorOutput, TUTOR_JSON_SCHEMA } from '../domain/tutor/schema.js';
import { summariseSession } from '../domain/tutor/summary.js';
import type { DrillState } from '../lib/sessionState.js';
import { turnMetrics } from '../lib/telemetry.js';
import type { ChatMessage, LlmUsage } from '../providers/llm/types.js';
import type { SafetyProfile, SafetyVerdict } from '../providers/safety/types.js';
import type { StreamingRecognition } from '../providers/speech/types.js';
import type { TtsProvider } from '../providers/tts/types.js';
import type { ServerMessage, WireWord } from '../ws/protocol.js';

/** End-of-speech silence by level (PRD §11: tune endpointing longer for beginners, who pause more). */
const SILENCE_MS: Record<Cefr, number> = { A1: 900, A2: 800, B1: 650, B2: 550, C1: 500, C2: 500 };
const KID_EXTRA_SILENCE_MS = 150;
const BYTES_PER_SECOND = 16_000 * 2;

const ESCALATION_MESSAGE =
  "I'm really sorry you're feeling this way. You are not alone. Please talk to a parent, teacher, or someone you trust right now. " +
  'You can also call the Tele-MANAS helpline at 14416, any time, for free.';
const BLOCKED_INPUT_REPLY = "Let's keep our practice friendly and safe. Can you tell me about something you enjoyed today?";

export interface Transport {
  send(msg: ServerMessage): void;
  sendAudio(chunk: Buffer, meta: { seq: number; sentence: number; last: boolean; mime: string }): void;
}

interface Utterance {
  pcm: Buffer[];
  bytes: number;
  /** Audio received before the recogniser finished connecting. */
  pending: Buffer[];
  rec: StreamingRecognition | null;
  starting: Promise<StreamingRecognition>;
}

interface TurnTimings {
  speechEnd: number;
  sttDone?: number;
  llmFirstToken?: number;
  firstSentence?: number;
  firstAudio?: number;
  llmDone?: number;
  end?: number;
}

/**
 * One live WebSocket session: audio in → STT + pronunciation assessment → deterministic pron
 * triage → streaming LLM (JSON) → sentence-level streaming TTS → audio out, then persistence.
 */
export class SessionPipeline {
  /** The utterance currently being captured. Each has its own recogniser so late starts can't leak across turns. */
  private utterance: Utterance | null = null;
  private turnDetection: 'server' | 'client' = 'client';
  private speaking: AbortController | null = null;
  private turnChain: Promise<void> = Promise.resolve();
  private profile: ErrorProfileItem[] = [];
  private systemPrompt = '';
  private audioSeq = 0;
  private turnSeq = 1;
  private readonly tts: TtsProvider & { close(): void; warm?(): void };
  private closed = false;

  constructor(
    private readonly deps: Deps,
    private readonly learner: Learner,
    private readonly session: Session,
    private readonly scenario: Scenario | null,
    private readonly transport: Transport,
  ) {
    this.tts = deps.createTts();
  }

  private get safetyProfile(): SafetyProfile {
    return this.learner.ageBand === 'kid' ? 'kid' : 'standard';
  }

  private get llmTier(): 'kids' | 'tutor' {
    return this.learner.ageBand === 'kid' ? 'kids' : 'tutor';
  }

  async init(): Promise<void> {
    this.tts.warm?.();
    this.profile = await this.deps.repo.getErrorProfile(this.learner.id);
    this.turnSeq = await this.deps.repo.nextTurnSeq(this.session.id);
    this.rebuildSystemPrompt();
    this.transport.send({
      type: 'ready',
      session_id: this.session.id,
      mode: this.session.mode,
      audio_format: this.tts.outputFormat.mime,
      turn_detection: this.turnDetection,
    });
    // Opening line (role-play scenario or tutor greeting) only on a fresh session.
    if (this.turnSeq === 1) {
      const opening =
        this.session.mode === 'roleplay' && this.scenario
          ? this.scenario.openingLine
          : this.session.mode === 'drill'
            ? "Let's practise some sounds! Choose a sentence, listen, and then say it."
            : `Hi${this.learner.displayName ? ` ${this.learner.displayName}` : ''}! I'm Nova, your English buddy. What did you do today?`;
      // Greeting plays in the background so the learner can start speaking immediately.
      void this.deps.state.appendHistory(this.session.id, '(session started)', opening);
      this.speaking = new AbortController();
      void this.speakFixed(opening);
    }
  }

  setTurnDetection(mode: 'server' | 'client'): void {
    this.turnDetection = mode;
  }

  // ------------------------------------------------------------------ audio in

  async onAudio(pcm: Buffer): Promise<void> {
    if (this.closed || pcm.length === 0) return;
    if (!this.utterance) {
      const u: Utterance = { pcm: [], bytes: 0, pending: [], rec: null, starting: undefined as never };
      u.starting = this.startRecognition(u);
      u.starting.catch(() => undefined);
      this.utterance = u;
    }
    const u = this.utterance;
    u.pcm.push(pcm);
    u.bytes += pcm.length;
    if (u.rec) u.rec.write(pcm);
    else u.pending.push(pcm);
    if (u.bytes > this.deps.env.MAX_UTTERANCE_SECONDS * BYTES_PER_SECOND) this.endUtterance();
  }

  private async startRecognition(u: Utterance): Promise<StreamingRecognition> {
    const drill = await this.deps.state.getDrill(this.session.id);
    const beginnerExtra = this.learner.ageBand === 'kid' ? KID_EXTRA_SILENCE_MS : 0;
    const phrases = [
      ...this.deps.policy.neutralWords.words,
      ...(this.scenario?.targetVocab ?? []),
      ...this.deps.env.STT_PHRASE_LIST_EXTRA.split(',').map((s) => s.trim()).filter(Boolean),
      ...(this.learner.displayName ? [this.learner.displayName] : []),
    ];
    try {
      const rec = await this.deps.speech.start(
        {
          referenceText: drill?.reference,
          segmentationSilenceMs: SILENCE_MS[this.learner.cefrLevel] + beginnerExtra,
          phrases,
          prosody: true,
        },
        {
          onPartial: (text) => this.transport.send({ type: 'partial_transcript', text }),
          onSegment: () => {
            if (this.turnDetection === 'server' && this.utterance === u) this.endUtterance();
          },
          onError: (err, retryable) => {
            this.deps.log.warn({ err: err.message }, 'recognition error');
            this.transport.send({ type: 'error', code: 'stt_failed', retryable });
          },
        },
      );
      for (const chunk of u.pending) rec.write(chunk);
      u.pending = [];
      u.rec = rec;
      return rec;
    } catch (err) {
      if (this.utterance === u) this.utterance = null;
      this.transport.send({ type: 'error', code: 'stt_unavailable', retryable: true });
      throw err;
    }
  }

  /** Close the current utterance and queue its turn. Turns are processed strictly in order. */
  endUtterance(): void {
    const u = this.utterance;
    if (!u) return;
    this.utterance = null;
    const pcm = Buffer.concat(u.pcm);
    const timings: TurnTimings = { speechEnd: Date.now() };
    this.turnChain = this.turnChain
      .then(async () => {
        const rec = await u.starting;
        const assessment = await rec.finish();
        timings.sttDone = Date.now();
        await this.runTurn(assessment, pcm, timings);
      })
      .catch((err) => {
        this.deps.log.error({ err }, 'turn failed');
        this.transport.send({ type: 'error', code: 'turn_failed', retryable: true });
      });
  }

  interrupt(): void {
    this.speaking?.abort();
  }

  async setReference(text: string): Promise<void> {
    const words = text.toLowerCase().split(/\s+/);
    const lastFocus = this.lastFocusWord && words.includes(this.lastFocusWord.toLowerCase()) ? this.lastFocusWord : null;
    const drill: DrillState = { reference: text, focusWord: lastFocus, attempt: 0, origin: this.session.mode === 'drill' ? 'client' : 'coaching' };
    await this.deps.state.setDrill(this.session.id, drill);
    await this.sendModelAudio(text);
  }

  async clearReference(): Promise<void> {
    await this.deps.state.setDrill(this.session.id, null);
  }

  private lastFocusWord: string | null = null;

  // ------------------------------------------------------------------ the turn

  private async runTurn(assessment: UtteranceAssessment, pcm: Buffer, t: TurnTimings): Promise<void> {
    const { deps, learner } = this;
    if (!assessment.text.trim()) {
      this.transport.send({ type: 'error', code: 'no_speech', message: "I couldn't hear you. Please try again.", retryable: true });
      return;
    }
    if (!(await deps.state.allowTurn(learner.id, deps.env.RATE_LIMIT_TURNS_PER_MIN))) {
      this.transport.send({ type: 'error', code: 'rate_limited', retryable: true });
      return;
    }

    const drill = await deps.state.getDrill(this.session.id);
    const policy = deps.policy;
    let selection: SelectorResult = selectPronunciationFocus(policy, {
      words: assessment.words,
      l1: learner.l1,
      ageBand: learner.ageBand,
      profile: this.profile,
      scripted: Boolean(drill),
    });
    // In a drill, coach only the drill's focus word when one is set.
    if (drill?.focusWord) {
      const f = selection.flagged.find((w) => w.word.toLowerCase() === drill.focusWord!.toLowerCase());
      selection = { ...selection, focus: f ? { word: f.word, score: Math.round(f.score), expected: f.expected, heard: f.heard, rule: f.rule.id, profileKey: f.rule.profileKey } : null };
    }
    this.sendFinalTranscript(assessment, selection);

    // Drill bookkeeping (PRD §10.5: pass at >= 75, retry up to 3 times, then move on).
    let drillInfo: { reference: string; attempt: number; maxAttempts: number; passed: boolean } | null = null;
    if (drill) {
      const target = drill.focusWord ? assessment.words.find((w) => w.w.toLowerCase() === drill.focusWord!.toLowerCase())?.score : null;
      const score = target ?? assessment.scores.pronunciation ?? assessment.scores.accuracy ?? 0;
      drillInfo = {
        reference: drill.reference,
        attempt: drill.attempt + 1,
        maxAttempts: policy.thresholds.drillMaxAttempts,
        passed: score >= policy.thresholds.drillPass,
      };
    }

    const pronFocusText = selection.focus ? describeFocus(selection.focus, policy) : null;
    const history = await deps.state.history(this.session.id);
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...history,
      { role: 'user', content: buildTurnInput({ assessment, pronFocus: pronFocusText, drill: drillInfo }) },
    ];

    // Input safety runs in parallel with the LLM; audio is held until it clears (usually well before the first sentence).
    const inputVerdict = deps.safety.checkInput(assessment.text, this.safetyProfile).catch(
      (): SafetyVerdict => ({ allowed: true, category: null, severity: 0, escalate: false }),
    );
    const speaking = new AbortController();
    this.speaking = speaking;
    let suppressed = false; // safety suppression (as opposed to a learner barge-in)
    const suppress = () => {
      suppressed = true;
      speaking.abort();
    };

    let sentenceNo = 0;
    let spokenReply = '';
    let ttsChars = 0;
    let ttsChain: Promise<void> = Promise.resolve();

    const speakSentence = (sentence: string) => {
      const n = sentenceNo++;
      if (t.firstSentence === undefined) t.firstSentence = Date.now();
      spokenReply += (spokenReply ? ' ' : '') + sentence;
      ttsChars += sentence.length;
      const outputCheck = this.safetyProfile === 'kid' ? deps.safety.checkOutput(sentence, 'kid') : null;
      // Synthesis starts immediately; chunks are released only after safety gates pass.
      const buffered: Buffer[] = [];
      let released = false;
      const gate = Promise.all([inputVerdict, outputCheck]).then(([inV, outV]) => {
        if (!inV.allowed || inV.escalate || (outV && !outV.allowed)) {
          suppress();
          return false;
        }
        released = true;
        if (!speaking.signal.aborted) for (const c of buffered.splice(0)) this.emitAudio(c, n, false, t);
        return true;
      });
      const synth = this.tts.synthesizeStream(
        { text: sentence, role: 'conversation' },
        (chunk) => {
          if (speaking.signal.aborted) return;
          if (released) this.emitAudio(chunk, n, false, t);
          else buffered.push(chunk);
        },
        speaking.signal,
      );
      ttsChain = ttsChain.then(async () => {
        const [ok] = await Promise.all([gate, synth.catch((err) => deps.log.warn({ err: err.message }, 'tts sentence failed'))]);
        if (ok && !speaking.signal.aborted) this.transport.send({ type: 'reply_text', text: sentence, sentence: n });
      });
    };

    const makeParser = () => {
      const splitter = new SentenceSplitter(speakSentence);
      const scanner = new TopLevelJsonStream({
        onStringDelta: (key, text) => {
          if (key === 'reply') splitter.push(text);
        },
        onMember: (key, raw) => {
          if (key === 'reply') splitter.flush();
          // Escalation: don't voice the model's reply; the template is spoken instead.
          if (key === 'safety_flag' && (raw === '"self_harm"' || raw === '"abuse"')) suppress();
        },
      });
      return { splitter, scanner };
    };

    let output: TutorOutput | null = null;
    let usage: LlmUsage | null = null;
    let llmFiltered = false;
    let parser = makeParser();
    for (let attempt = 0; attempt < 2 && !output; attempt++) {
      if (attempt === 1) {
        if (spokenReply) break; // never retry once the learner has heard part of the reply
        parser = makeParser();
      }
      const current = parser;
      const res = await deps.llm.streamJson(
        { messages, schema: TUTOR_JSON_SCHEMA, maxOutputTokens: deps.env.LLM_MAX_OUTPUT_TOKENS, tier: this.llmTier },
        (delta) => {
          if (t.llmFirstToken === undefined) t.llmFirstToken = Date.now();
          current.scanner.write(delta);
        },
      );
      usage = res.usage;
      llmFiltered = res.filtered;
      if (llmFiltered) break;
      output = parseTutorOutput(res.text, selection.focus?.word ?? null);
      if (!output) turnMetrics.fallbacks.add(1, { attempt: String(attempt) });
    }
    parser.splitter.flush();
    t.llmDone = Date.now();

    const verdict = await inputVerdict;
    let safety: { escalation: true; message: string } | null = null;
    if (verdict.escalate || output?.safety_flag === 'self_harm' || output?.safety_flag === 'abuse') {
      suppress();
      safety = { escalation: true, message: ESCALATION_MESSAGE };
      output = { ...fallbackOutput(ESCALATION_MESSAGE), safety_flag: output?.safety_flag ?? 'self_harm' };
      turnMetrics.safetyBlocks.add(1, { kind: 'escalation' });
    } else if (!verdict.allowed || llmFiltered) {
      suppress();
      output = fallbackOutput(BLOCKED_INPUT_REPLY);
      turnMetrics.safetyBlocks.add(1, { kind: verdict.category ?? 'llm_filter' });
    } else if (!output) {
      output = fallbackOutput(spokenReply || null);
    }

    await ttsChain;
    // If the streamed audio was suppressed (safety) or nothing was spoken (fallback), voice the final reply now.
    // A learner barge-in (interrupt) is respected: nothing is replayed.
    const interrupted = speaking.signal.aborted && !suppressed;
    if (!interrupted && (suppressed || !spokenReply)) {
      this.speaking = new AbortController();
      await this.speakFixed(output.reply, t, sentenceNo);
    } else {
      this.markLastAudio(sentenceNo - 1);
    }

    this.transport.send({
      type: 'feedback',
      reply: output.reply,
      correction: output.correction ? { original: output.correction.original, fixed: output.correction.fixed, why: output.correction.why } : null,
      pron_tip: output.pron_tip,
      next_prompt: output.next_prompt,
      drill: drillInfo
        ? { ...drillInfo, max_attempts: drillInfo.maxAttempts, done: drillInfo.passed || drillInfo.attempt >= drillInfo.maxAttempts }
        : null,
      safety,
    });
    if (output.pron_tip && !drill) {
      this.lastFocusWord = output.pron_tip.word;
      // Coaching loop step 1: model audio in the clear voice; the client may reply with set_reference.
      void this.sendModelAudio(output.pron_tip.word);
    }
    t.end = Date.now();

    const latency = this.latencyReport(t);
    turnMetrics.firstAudioMs.record(latency.first_audio ?? 0, { mode: this.session.mode });
    const turnId = await this.persist({ assessment, selection, output, drill, drillInfo, pcm, usage, latency, ttsChars }).catch((err) => {
      deps.log.error({ err }, 'persist failed');
      return null;
    });
    this.transport.send({ type: 'turn_end', turn_id: turnId, latency_ms: latency });

    // Not awaited: finishSession waits for the turn chain, which includes this turn.
    if (output.scene_complete && this.session.mode === 'roleplay') void this.finishSession();
  }

  // ------------------------------------------------------------------ helpers

  private sendFinalTranscript(a: UtteranceAssessment, sel: SelectorResult): void {
    const flaggedIdx = new Set(sel.flagged.filter((f) => f.severity >= 0.25).map((f) => f.index));
    const words: WireWord[] = a.words.map((w, i) => ({
      w: w.w,
      score: Math.round(w.score),
      error: w.error,
      highlight: flaggedIdx.has(i),
      phonemes: w.phonemes.filter((p) => p.p).map((p) => ({ p: p.p, score: Math.round(p.score), ...(p.heard ? { heard: p.heard } : {}) })),
    }));
    this.transport.send({ type: 'final_transcript', text: a.text, words, scores: a.scores, scores_are_estimates: true });
  }

  private emitAudio(chunk: Buffer, sentence: number, last: boolean, t?: TurnTimings): void {
    if (t && t.firstAudio === undefined) t.firstAudio = Date.now();
    this.transport.sendAudio(chunk, { seq: this.audioSeq++, sentence, last, mime: this.tts.outputFormat.mime });
  }

  private markLastAudio(sentence: number): void {
    this.transport.sendAudio(Buffer.alloc(0), { seq: this.audioSeq++, sentence, last: true, mime: this.tts.outputFormat.mime });
  }

  /** Speak a fixed text (greetings, fallbacks, escalation) as one sentence. */
  private async speakFixed(text: string, t?: TurnTimings, sentence = 0): Promise<void> {
    const signal = this.speaking?.signal;
    try {
      await this.tts.synthesizeStream({ text, role: 'conversation' }, (c) => this.emitAudio(c, sentence, false, t), signal);
      this.transport.send({ type: 'reply_text', text, sentence });
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'fixed tts failed');
    }
    this.markLastAudio(sentence);
  }

  private async sendModelAudio(text: string): Promise<void> {
    try {
      const audio = await this.deps.ttsCache.get({ text, role: 'clear' });
      this.transport.send({ type: 'model_audio', text, data: audio.toString('base64'), mime: this.tts.outputFormat.mime });
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'model audio failed');
    }
  }

  private latencyReport(t: TurnTimings): Record<string, number> {
    const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : -1);
    const r = {
      stt_finalize: d(t.speechEnd, t.sttDone),
      llm_first_token: d(t.sttDone, t.llmFirstToken),
      llm_first_sentence: d(t.sttDone, t.firstSentence),
      first_audio: d(t.speechEnd, t.firstAudio),
      llm_total: d(t.sttDone, t.llmDone),
      total: d(t.speechEnd, t.end),
    };
    for (const [stage, ms] of Object.entries(r)) if (ms >= 0) turnMetrics.stageMs.record(ms, { stage });
    return r;
  }

  private async persist(args: {
    assessment: UtteranceAssessment;
    selection: SelectorResult;
    output: TutorOutput;
    drill: DrillState | null;
    drillInfo: { attempt: number; maxAttempts: number; passed: boolean } | null;
    pcm: Buffer;
    usage: LlmUsage | null;
    latency: Record<string, number>;
    ttsChars: number;
  }): Promise<string> {
    const { deps, learner, session } = this;
    const { assessment, selection, output } = args;
    const seq = this.turnSeq++;

    // Error profile (PRD §8).
    const produced = new Map<string, number>();
    for (const w of assessment.words) for (const p of w.phonemes) if (p.p) produced.set(p.p, Math.min(produced.get(p.p) ?? 100, p.score));
    const observations = deriveObservations({
      flaggedKeys: selection.flagged.filter((f) => f.rule.kind !== 'generic_low_score' && f.severity >= 0.25).map((f) => f.rule.profileKey),
      grammarKey: output.correction?.key ?? null,
      practisedCorrectly: output.practised_correctly,
      producedPhonemes: produced,
      threshold: thresholdFor(deps.policy, learner.l1, learner.ageBand, ''),
      profile: this.profile,
    });
    await deps.repo.applyObservations(learner.id, observations);
    this.applyObservationsLocally(observations);

    // Opt-in audio (off by default, PRD §12).
    let audioUrl: string | null = null;
    let audioExpiresAt: Date | null = null;
    if (learner.consent.audioStorage && args.pcm.length) {
      audioUrl = await deps.audioStore.putUtterance(learner.id, session.id, seq, args.pcm).catch(() => null);
      if (audioUrl) audioExpiresAt = new Date(Date.now() + deps.env.AUDIO_RETENTION_DAYS * 86_400_000);
    }

    const cost = this.estimateCost(assessment.durationMs, args.usage, args.ttsChars);
    const id = await deps.repo.insertTurn({
      sessionId: session.id,
      seq,
      transcript: assessment.text,
      reference: args.drill?.reference ?? null,
      scores: { ...assessment.scores, longPauses: assessment.longPauses, scoringLocale: assessment.scoringLocale, words: assessment.words, acceptedVariantHits: selection.acceptedVariantHits },
      llm: { ...output, pron_focus: selection.focus?.word ?? null, pron_rule: selection.focus?.rule ?? null },
      latency: args.latency,
      cost,
      promptVersion: PROMPT_VERSION,
      audioUrl,
      audioExpiresAt,
    });

    await deps.state.appendHistory(session.id, `Learner said: "${assessment.text}"`, output.reply);
    if (args.drill && args.drillInfo) {
      const done = args.drillInfo.passed || args.drillInfo.attempt >= args.drillInfo.maxAttempts;
      await deps.state.setDrill(session.id, done ? null : { ...args.drill, attempt: args.drillInfo.attempt });
    }
    if (observations.length) this.rebuildSystemPrompt();
    return id;
  }

  private applyObservationsLocally(obs: ReturnType<typeof deriveObservations>): void {
    for (const o of obs) {
      const item = this.profile.find((p) => p.key === o.key);
      if (item) {
        item.mastery = updateMastery(item.mastery, o.correct);
        if (!o.correct) item.count++;
        item.lastSeen = new Date().toISOString();
      } else if (!o.correct) {
        this.profile.push({ category: o.category, key: o.key, count: 1, lastSeen: new Date().toISOString(), mastery: updateMastery(INITIAL_MASTERY, false) });
      }
    }
  }

  private estimateCost(audioMs: number, usage: LlmUsage | null, ttsChars: number) {
    const p = this.deps.pricing;
    const lanes = this.deps.env.PRON_DETAIL_MODE === 'dual' ? 2 : 1;
    const stt = (audioMs / 3_600_000) * p.sttPerAudioHour * lanes;
    const tts = (ttsChars / 1_000_000) * p.ttsPerMillionChars;
    const lp = p.llm[this.llmTier];
    const llm = usage
      ? ((usage.inputTokens - usage.cachedInputTokens) * lp.inputPerMillion + usage.cachedInputTokens * lp.cachedInputPerMillion + usage.outputTokens * lp.outputPerMillion) / 1_000_000
      : 0;
    const total = stt + tts + llm;
    turnMetrics.costUsdMicros.add(Math.round(total * 1e6), { mode: this.session.mode });
    turnMetrics.sttSeconds.add(audioMs / 1000);
    turnMetrics.ttsChars.add(ttsChars);
    if (usage) turnMetrics.llmTokens.add(usage.inputTokens + usage.outputTokens, { tier: this.llmTier });
    return { usd: { stt, tts, llm, total }, usage, ttsChars, audioMs };
  }

  private rebuildSystemPrompt(): void {
    this.systemPrompt = buildSystemPrompt({
      cefr: this.learner.cefrLevel,
      l1: this.learner.l1,
      ageBand: this.learner.ageBand,
      mode: this.session.mode,
      topErrors: formatTopErrors(topErrors(this.profile, 3)),
      scenario: this.scenario,
    });
  }

  async finishSession(): Promise<void> {
    await this.turnChain;
    const turns = await this.deps.repo.listTurns(this.session.id);
    const summary = await summariseSession(this.deps.llm, {
      ageBand: this.learner.ageBand,
      cefr: this.learner.cefrLevel,
      mode: this.session.mode,
      turns,
    }).catch((err) => {
      this.deps.log.error({ err }, 'summary failed');
      return null;
    });
    await this.deps.repo.endSession(this.session.id, summary);
    if (summary) this.transport.send({ type: 'session_summary', summary });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.speaking?.abort();
    this.utterance?.rec?.cancel();
    void this.utterance?.starting.then((r) => r.cancel(), () => undefined);
    await this.turnChain.catch(() => undefined);
    this.tts.close();
  }
}
