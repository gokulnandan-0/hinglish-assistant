import { z } from 'zod';

/** Client → server (PRD §7). Binary WS frames are treated as raw PCM audio. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('audio'), data: z.string().min(1) }),
  z.object({ type: z.literal('end_utterance') }),
  z.object({ type: z.literal('set_reference'), text: z.string().min(1).max(300) }),
  z.object({ type: z.literal('clear_reference') }),
  /** Barge-in: stop the tutor's current audio. */
  z.object({ type: z.literal('interrupt') }),
  /** 'server' = auto end-of-turn on silence; 'client' = push-to-talk with end_utterance. */
  z.object({ type: z.literal('config'), turn_detection: z.enum(['server', 'client']).optional(), binary_audio: z.boolean().optional() }),
  z.object({ type: z.literal('end_session') }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface WireWord {
  w: string;
  score: number;
  error: string;
  /** true when the word is an intelligibility issue worth highlighting (accepted variants are not). */
  highlight: boolean;
  phonemes: { p: string; score: number; heard?: string }[];
}

/** Server → client. `feedback`, `audio`, `turn_end`, etc. follow PRD §7; extras are marked. */
export type ServerMessage =
  | { type: 'ready'; session_id: string; mode: string; audio_format: string; turn_detection: 'server' | 'client' }
  | { type: 'partial_transcript'; text: string }
  | { type: 'final_transcript'; text: string; words: WireWord[]; scores: Record<string, number | null>; scores_are_estimates: true }
  | { type: 'reply_text'; text: string; sentence: number } // extra: caption for the sentence about to play
  | {
      type: 'feedback';
      reply: string;
      correction: { original: string; fixed: string; why: string } | null;
      pron_tip: { word: string; tip: string } | null;
      next_prompt: string;
      drill?: { reference: string; attempt: number; max_attempts: number; passed: boolean; done: boolean } | null;
      safety?: { escalation: true; message: string } | null;
    }
  | { type: 'audio'; data: string; seq: number; sentence: number; mime: string; last: boolean }
  | { type: 'model_audio'; text: string; data: string; mime: string } // extra: slow "clear" voice model for coaching
  | { type: 'turn_end'; turn_id: string | null; latency_ms: Record<string, number> }
  | { type: 'session_summary'; summary: unknown }
  | { type: 'error'; code: string; message?: string; retryable: boolean }
  | { type: 'pong' };
