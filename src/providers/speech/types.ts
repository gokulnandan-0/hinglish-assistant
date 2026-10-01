import type { UtteranceAssessment } from '../../domain/types.js';

/**
 * Vendor-neutral streaming recogniser + pronunciation assessor (PRD §16: STT/TTS/LLM behind
 * interfaces so Sarvam / AI4Bharat etc. can be evaluated later).
 */
export interface RecognitionOptions {
  /** Reference text => scripted assessment (drill). Absent => unscripted (tutor / role-play). */
  referenceText?: string;
  /** End-of-speech silence before a segment is finalised. Longer for beginners (PRD §11). */
  segmentationSilenceMs: number;
  /** Boost list: Indian names, places, Hinglish, scenario vocabulary. */
  phrases: string[];
  /** Ask the service for prosody scoring (only where the locale supports it). */
  prosody: boolean;
}

export interface RecognitionEvents {
  onPartial(text: string): void;
  /** A finalised speech segment (the utterance may contain several). */
  onSegment(segment: UtteranceAssessment): void;
  onError(err: Error, retryable: boolean): void;
}

export interface StreamingRecognition {
  /** Push 16 kHz / 16-bit / mono little-endian PCM. */
  write(pcm: Buffer): void;
  /** Stop accepting audio and resolve with the merged assessment of all segments. */
  finish(): Promise<UtteranceAssessment>;
  /** Abort without waiting for results. */
  cancel(): void;
}

export interface SpeechRecognizerProvider {
  start(opts: RecognitionOptions, events: RecognitionEvents): Promise<StreamingRecognition>;
}
