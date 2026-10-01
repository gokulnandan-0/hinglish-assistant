import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import type { Repo } from './db/repo.js';
import type { Db } from './db/pool.js';
import type { PronunciationPolicy } from './domain/pronunciation/policy.js';
import type { SessionState } from './lib/sessionState.js';
import type { LlmProvider } from './providers/llm/types.js';
import type { SafetyProvider } from './providers/safety/types.js';
import type { SpeechRecognizerProvider } from './providers/speech/types.js';
import type { AudioStore } from './providers/storage/audioStore.js';
import type { TtsCache } from './providers/tts/ttsCache.js';
import type { TtsProvider } from './providers/tts/types.js';
import type { Verifier } from './auth/jwt.js';

export interface Pricing {
  sttPerAudioHour: number;
  ttsPerMillionChars: number;
  llm: Record<'tutor' | 'kids' | 'summary', { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number }>;
}

export interface Deps {
  env: Env;
  log: Logger;
  db: Db;
  redis: Redis;
  repo: Repo;
  state: SessionState;
  policy: PronunciationPolicy;
  pricing: Pricing;
  speech: SpeechRecognizerProvider;
  /** A fresh, per-session TTS instance (keeps its own warm connection). */
  createTts: () => TtsProvider & { close(): void; warm?(): void };
  ttsCache: TtsCache;
  ttsMime: string;
  llm: LlmProvider;
  safety: SafetyProvider;
  audioStore: AudioStore;
  verify: Verifier;
}
