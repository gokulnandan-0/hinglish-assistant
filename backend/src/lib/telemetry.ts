import { metrics, type Histogram, type Counter } from '@opentelemetry/api';

/**
 * Application Insights via the Azure Monitor OpenTelemetry distro. Must be initialised before other
 * imports that should be auto-instrumented (http, pg, ioredis).
 */
export async function initTelemetry(connectionString: string | undefined): Promise<void> {
  if (!connectionString) return;
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
}

const meter = metrics.getMeter('nova-tutor');

export const turnMetrics: {
  firstAudioMs: Histogram;
  stageMs: Histogram;
  costUsdMicros: Counter;
  llmTokens: Counter;
  sttSeconds: Counter;
  ttsChars: Counter;
  fallbacks: Counter;
  safetyBlocks: Counter;
  detailMissed: Counter;
} = {
  firstAudioMs: meter.createHistogram('turn.first_audio_ms', { unit: 'ms', description: 'end of speech to first audio byte' }),
  stageMs: meter.createHistogram('turn.stage_ms', { unit: 'ms' }),
  costUsdMicros: meter.createCounter('turn.cost_usd_micros', { description: 'estimated cost in micro-USD' }),
  llmTokens: meter.createCounter('llm.tokens'),
  sttSeconds: meter.createCounter('stt.audio_seconds'),
  ttsChars: meter.createCounter('tts.characters'),
  fallbacks: meter.createCounter('llm.fallbacks'),
  safetyBlocks: meter.createCounter('safety.blocks'),
  detailMissed: meter.createCounter('pron.detail_missed'),
};
