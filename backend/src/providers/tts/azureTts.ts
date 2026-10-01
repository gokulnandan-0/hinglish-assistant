import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Env } from '../../config/env.js';
import { createSpeechConfig } from '../speech/speechConfig.js';
import type { SynthesisRequest, TtsProvider } from './types.js';

const FORMATS = {
  // Opus: ~16-24 kbps vs 384 kbps raw PCM; best for 4G/low-end Android (ExoPlayer/MediaCodec decode it natively).
  'ogg-opus': { sdk: sdk.SpeechSynthesisOutputFormat.Ogg24Khz16BitMonoOpus, mime: 'audio/ogg; codecs=opus', sampleRate: 24_000 },
  'webm-opus': { sdk: sdk.SpeechSynthesisOutputFormat.Webm24Khz16BitMonoOpus, mime: 'audio/webm; codecs=opus', sampleRate: 24_000 },
  mp3: { sdk: sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3, mime: 'audio/mpeg', sampleRate: 24_000 },
  pcm: { sdk: sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm, mime: 'audio/L16; rate=24000', sampleRate: 24_000 },
  // Same format the recogniser consumes; used by the smoke test / eval loopback.
  pcm16: { sdk: sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm, mime: 'audio/L16; rate=16000', sampleRate: 16_000 },
} as const;

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/**
 * Azure Neural TTS. One synthesizer per session is kept warm (pre-connected) and reused, as the
 * Microsoft latency guide recommends; sentences are synthesised sequentially and each audio chunk is
 * forwarded as soon as the service emits it.
 */
export class AzureTts implements TtsProvider {
  readonly outputFormat: TtsProvider['outputFormat'];
  private synth: sdk.SpeechSynthesizer | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly env: Env) {
    const f = FORMATS[env.TTS_OUTPUT_FORMAT];
    this.outputFormat = { mime: f.mime, sampleRate: f.sampleRate, name: env.TTS_OUTPUT_FORMAT };
  }

  /** Open the websocket ahead of the first sentence to save the TLS/handshake time. */
  warm(): void {
    const synth = this.getSynth();
    try {
      sdk.Connection.fromSynthesizer(synth).openConnection();
    } catch {
      /* best effort */
    }
  }

  buildSsml(req: SynthesisRequest): string {
    const voice = this.voiceFor(req);
    const lang = req.locale ?? voice.slice(0, 5);
    const rate = req.rate ?? (req.role === 'clear' ? this.env.TTS_CLEAR_RATE : 1);
    const lexicon = this.env.TTS_LEXICON_URL && lang.startsWith('en') ? `<lexicon uri="${escapeXml(this.env.TTS_LEXICON_URL)}"/>` : '';
    const body = escapeXml(req.text);
    const inner = rate === 1 ? body : `<prosody rate="${Math.round(rate * 100)}%">${body}</prosody>`;
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${lexicon}${inner}</voice></speak>`;
  }

  synthesizeStream(req: SynthesisRequest, onChunk: (chunk: Buffer) => void, signal?: AbortSignal): Promise<void> {
    // Serialise on the shared synthesizer so chunks of consecutive sentences never interleave.
    const run = this.queue.then(() => this.speak(req, onChunk, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async synthesize(req: SynthesisRequest): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.synthesizeStream(req, (c) => chunks.push(c));
    return Buffer.concat(chunks);
  }

  close(): void {
    this.synth?.close();
    this.synth = null;
  }

  private speak(req: SynthesisRequest, onChunk: (chunk: Buffer) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    const synth = this.getSynth();
    return new Promise((resolve, reject) => {
      let aborted = false;
      const onAbort = () => {
        // Barge-in: drop this synthesizer so late chunks can't leak into the next sentence.
        aborted = true;
        this.discard(synth);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      synth.synthesizing = (_s, e) => {
        if (!aborted && e.result.audioData?.byteLength) onChunk(Buffer.from(e.result.audioData));
      };
      synth.speakSsmlAsync(
        this.buildSsml(req),
        (result) => {
          signal?.removeEventListener('abort', onAbort);
          if (result.reason === sdk.ResultReason.Canceled) {
            const details = sdk.CancellationDetails.fromResult(result);
            // Recreate the synthesizer after an error; its connection may be unusable.
            this.discard(synth);
            if (aborted) resolve();
            else reject(new Error(`tts canceled: ${details.errorDetails}`));
          } else resolve();
        },
        (err) => {
          signal?.removeEventListener('abort', onAbort);
          this.discard(synth);
          if (aborted) resolve();
          else reject(new Error(`tts error: ${err}`));
        },
      );
    });
  }

  private discard(synth: sdk.SpeechSynthesizer): void {
    if (this.synth === synth) this.synth = null;
    try {
      synth.close();
    } catch {
      /* already closed */
    }
  }

  private getSynth(): sdk.SpeechSynthesizer {
    if (this.synth) return this.synth;
    const config = createSpeechConfig(this.env);
    config.speechSynthesisOutputFormat = FORMATS[this.env.TTS_OUTPUT_FORMAT].sdk;
    this.synth = new sdk.SpeechSynthesizer(config, null);
    return this.synth;
  }

  private voiceFor(req: SynthesisRequest): string {
    if (req.role === 'clear') return this.env.TTS_VOICE_CLEAR;
    if (req.role === 'l1_hint') return this.env.TTS_VOICE_L1_HINT;
    return this.env.TTS_VOICE_CONVERSATION;
  }
}
