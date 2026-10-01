export type VoiceRole = 'conversation' | 'clear' | 'l1_hint';

export interface SynthesisRequest {
  text: string;
  role: VoiceRole;
  /** Relative speaking rate, e.g. 1.0 normal, 0.8 slow model pronunciation. */
  rate?: number;
  /** BCP-47 locale for L1 hints (e.g. hi-IN). */
  locale?: string;
}

export interface TtsProvider {
  /** Stream audio chunks for one utterance. Chunks are in `outputFormat`. */
  synthesizeStream(req: SynthesisRequest, onChunk: (chunk: Buffer) => void, signal?: AbortSignal): Promise<void>;
  /** Whole-clip synthesis (previews, cached word models). */
  synthesize(req: SynthesisRequest): Promise<Buffer>;
  readonly outputFormat: { mime: string; sampleRate: number; name: string };
}
