import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),

  // ---- Auth ----
  // Production: JWTs issued by Microsoft Entra External ID (phone OTP / email).
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  // Development only: HS256 shared secret so the API can be exercised without an IdP.
  AUTH_DEV_SECRET: z.string().min(16).optional(),

  // ---- Azure AI Speech (STT + Pronunciation Assessment + TTS) ----
  // Speech is NOT offered in South India; Central India is the in-country region.
  AZURE_SPEECH_REGION: z.string().default('centralindia'),
  AZURE_SPEECH_KEY: z.string().optional(),
  // Custom-domain endpoint (https://<name>.cognitiveservices.azure.com/). With no key => Entra ID (managed identity).
  AZURE_SPEECH_ENDPOINT: z.string().url().optional(),
  // Optional Custom Speech endpoint (phase 4) - used for en-IN recognition when set.
  AZURE_SPEECH_CUSTOM_ENDPOINT_ID: z.string().optional(),
  // 'dual' = en-IN transcript/word scores + parallel en-US pass for phoneme names, NBest and prosody
  // (these are en-US-only features). 'single' = en-IN only (cheaper, no phoneme-level coaching).
  PRON_DETAIL_MODE: z.enum(['dual', 'single']).default('dual'),
  // How long after the en-IN final result we wait for the en-US detail pass before proceeding without it.
  PRON_DETAIL_GRACE_MS: z.coerce.number().int().default(350),
  STT_PHRASE_LIST_EXTRA: z.string().default(''),

  // ---- TTS voices ----
  TTS_VOICE_CONVERSATION: z.string().default('en-IN-NeerjaNeural'),
  TTS_VOICE_CLEAR: z.string().default('en-IN-PrabhatNeural'),
  TTS_VOICE_L1_HINT: z.string().default('hi-IN-SwaraNeural'),
  TTS_CLEAR_RATE: z.coerce.number().default(0.85),
  TTS_OUTPUT_FORMAT: z.enum(['ogg-opus', 'webm-opus', 'mp3', 'pcm', 'pcm16']).default('ogg-opus'),
  // Optional custom lexicon (PLS) for Indian proper nouns / tricky words, hosted in Blob.
  TTS_LEXICON_URL: z.string().url().optional(),

  // ---- Azure OpenAI (Foundry) ----
  // Resource in South India (Azure OpenAI is not listed for Central India). v1 API: <endpoint>/openai/v1/
  AZURE_OPENAI_ENDPOINT: z.string().url(),
  // Omit to use Entra ID (managed identity) via DefaultAzureCredential.
  AZURE_OPENAI_API_KEY: z.string().optional(),
  // For reasoning models (gpt-5.x): 'none' | 'minimal' | 'low'. Leave empty for non-reasoning models (gpt-4o, gpt-4.1-mini).
  AZURE_OPENAI_REASONING_EFFORT: z.enum(['', 'none', 'minimal', 'low', 'medium']).default(''),
  // 'json_schema' (strict structured outputs) or 'json_object' fallback if a model/deployment rejects schemas.
  AZURE_OPENAI_RESPONSE_FORMAT: z.enum(['json_schema', 'json_object']).default('json_schema'),
  // Fast conversational model (every turn).
  AZURE_OPENAI_TUTOR_DEPLOYMENT: z.string().default('tutor-fast'),
  // Stronger model for session summaries / offline eval judging.
  AZURE_OPENAI_SUMMARY_DEPLOYMENT: z.string().default('tutor-summary'),
  // Kids deployment bound to a stricter content-filter policy. Falls back to the tutor deployment.
  AZURE_OPENAI_KIDS_DEPLOYMENT: z.string().optional(),

  // ---- Azure AI Content Safety ----
  AZURE_CONTENT_SAFETY_ENDPOINT: z.string().url().optional(),
  AZURE_CONTENT_SAFETY_KEY: z.string().optional(),

  // ---- Data ----
  DATABASE_URL: z.string(),
  DATABASE_SSL: bool.default(false),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AZURE_STORAGE_ACCOUNT_URL: z.string().url().optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AUDIO_CONTAINER: z.string().default('learner-audio'),
  TTS_CACHE_CONTAINER: z.string().default('tts-cache'),
  AUDIO_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  // ---- Telemetry ----
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

  // ---- Tuning ----
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(300),
  RATE_LIMIT_TURNS_PER_MIN: z.coerce.number().int().default(20),
  MAX_UTTERANCE_SECONDS: z.coerce.number().int().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.AUTH_JWKS_URL) {
    throw new Error('AUTH_JWKS_URL is required in production');
  }
  if (!env.AZURE_SPEECH_KEY && !env.AZURE_SPEECH_ENDPOINT) {
    throw new Error('Set AZURE_SPEECH_KEY, or AZURE_SPEECH_ENDPOINT for Entra ID auth');
  }
  cached = env;
  return env;
}
