import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SynthesisRequest, TtsProvider } from './types.js';

export type TtsFactory = () => TtsProvider & { close(): void };

const TTL_SECONDS = 30 * 24 * 3600;
const MAX_CACHEABLE_CHARS = 200;

/**
 * Cache for fixed phrases and word models (PRD §11/§14: "cache TTS for fixed phrases and word
 * models"). Conversational replies are unique and never cached.
 */
export class TtsCache {
  constructor(
    private readonly redis: Redis,
    private readonly factory: TtsFactory,
    private readonly voiceKey: (req: SynthesisRequest) => string,
    private readonly formatName: string,
  ) {}

  /** One short-lived synthesizer per miss, so concurrent previews don't queue behind each other. */
  private async synth(req: SynthesisRequest): Promise<Buffer> {
    const tts = this.factory();
    try {
      return await tts.synthesize(req);
    } finally {
      tts.close();
    }
  }

  key(req: SynthesisRequest): string {
    const h = createHash('sha256')
      .update([this.voiceKey(req), req.rate ?? 1, this.formatName, req.text.trim().toLowerCase()].join('|'))
      .digest('hex');
    return `tts:${h}`;
  }

  async get(req: SynthesisRequest): Promise<Buffer> {
    if (req.text.length > MAX_CACHEABLE_CHARS) return this.synth(req);
    const key = this.key(req);
    const hit = await this.redis.getBuffer(key);
    if (hit) return hit;
    const audio = await this.synth(req);
    await this.redis.set(key, audio, 'EX', TTL_SECONDS);
    return audio;
  }
}
