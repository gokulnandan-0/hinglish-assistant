import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { loadEnv } from './config/env.js';
import { initTelemetry } from './lib/telemetry.js';

const env = loadEnv();
await initTelemetry(env.APPLICATIONINSIGHTS_CONNECTION_STRING);

// Imported after telemetry so http/pg/redis are auto-instrumented.
const { createLogger } = await import('./lib/logger.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { seedScenarios } = await import('./db/seed.js');
const { Repo } = await import('./db/repo.js');
const { SessionState } = await import('./lib/sessionState.js');
const { loadPronunciationPolicy } = await import('./domain/pronunciation/policy.js');
const { AzureSpeechRecognizer } = await import('./providers/speech/azureRecognizer.js');
const { AzureTts } = await import('./providers/tts/azureTts.js');
const { TtsCache } = await import('./providers/tts/ttsCache.js');
const { AzureOpenAiLlm } = await import('./providers/llm/azureOpenAi.js');
const { AzureContentSafety, NoopSafety } = await import('./providers/safety/azureContentSafety.js');
const { BlobAudioStore, DisabledAudioStore } = await import('./providers/storage/audioStore.js');
const { createVerifier } = await import('./auth/jwt.js');
const { buildServer } = await import('./server.js');
const { startRetentionJob } = await import('./jobs/retention.js');

const log = createLogger(env.LOG_LEVEL);
const db = createPool(env);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
const policy = loadPronunciationPolicy();
const configDir = process.env.CONFIG_DIR ?? resolve(process.cwd(), 'config');
const pricing = JSON.parse(readFileSync(resolve(configDir, 'pricing.json'), 'utf8'));

const createTts = () => new AzureTts(env);
const probe = createTts();
const voiceKey = (req: { role: string; locale?: string }) =>
  req.role === 'clear' ? env.TTS_VOICE_CLEAR : req.role === 'l1_hint' ? env.TTS_VOICE_L1_HINT : env.TTS_VOICE_CONVERSATION;

const deps = {
  env,
  log,
  db,
  redis,
  repo: new Repo(db),
  state: new SessionState(redis),
  policy,
  pricing,
  speech: new AzureSpeechRecognizer(env, log, policy.thresholds.enUsPhonemeCalibration),
  createTts,
  ttsCache: new TtsCache(redis, createTts, voiceKey, env.TTS_OUTPUT_FORMAT),
  ttsMime: probe.outputFormat.mime,
  llm: new AzureOpenAiLlm(env),
  safety: env.AZURE_CONTENT_SAFETY_ENDPOINT ? new AzureContentSafety(env, log) : new NoopSafety(),
  audioStore: env.AZURE_STORAGE_ACCOUNT_URL || env.AZURE_STORAGE_CONNECTION_STRING ? new BlobAudioStore(env) : new DisabledAudioStore(),
  verify: createVerifier(env),
};
probe.close();

if (!env.AZURE_CONTENT_SAFETY_ENDPOINT) log.warn('AZURE_CONTENT_SAFETY_ENDPOINT not set: relying on the Azure OpenAI content filter only');

const applied = await migrate(db);
if (applied.length) log.info({ applied }, 'migrations applied');
await seedScenarios(db);

const app = await buildServer(deps);
const stopRetention = startRetentionJob(deps);
await app.listen({ port: env.PORT, host: '0.0.0.0' });

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  stopRetention();
  await app.close();
  await Promise.allSettled([db.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
