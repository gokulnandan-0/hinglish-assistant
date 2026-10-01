import { describe, expect, it } from 'vitest';
import { mergeDetail, mergeSegments, parseAzureSegment } from '../src/providers/speech/assessmentParser.js';

const seg = (words: { Word: string; Offset: number; Duration: number; score: number; phonemes?: { Phoneme: string; score: number; nbest?: string }[] }[], extra = {}) =>
  JSON.stringify({
    RecognitionStatus: 'Success',
    DisplayText: words.map((w) => w.Word).join(' '),
    Duration: 30_000_000,
    NBest: [
      {
        PronunciationAssessment: { AccuracyScore: 80, FluencyScore: 70, CompletenessScore: 100, PronScore: 75, ...extra },
        Words: words.map((w) => ({
          Word: w.Word,
          Offset: w.Offset,
          Duration: w.Duration,
          PronunciationAssessment: { AccuracyScore: w.score, ErrorType: w.score < 60 ? 'Mispronunciation' : 'None' },
          Phonemes: (w.phonemes ?? []).map((p) => ({
            Phoneme: p.Phoneme,
            PronunciationAssessment: { AccuracyScore: p.score, ...(p.nbest ? { NBestPhonemes: [{ Phoneme: p.nbest, Score: 90 }] } : {}) },
          })),
        })),
      },
    ],
  });

describe('assessment parsing', () => {
  it('parses words, SAPI phonemes → IPA, NBest heard, and long pauses', () => {
    const a = parseAzureSegment(
      seg([
        { Word: 'i', Offset: 0, Duration: 2_000_000, score: 95 },
        { Word: 'think', Offset: 12_000_000, Duration: 4_000_000, score: 50, phonemes: [{ Phoneme: 'th', score: 30, nbest: 't' }, { Phoneme: 'ih', score: 90 }] },
      ]),
      'en-US',
    )!;
    expect(a.words[1]!.phonemes[0]).toEqual({ p: 'θ', score: 30, heard: 't' });
    expect(a.words[1]!.phonemes[1]).toEqual({ p: 'ɪ', score: 90 });
    expect(a.longPauses).toBe(1);
    expect(a.durationMs).toBe(3000);
  });

  it('merges en-US phoneme detail into en-IN words by time + text, with calibration', () => {
    const primary = parseAzureSegment(seg([{ Word: 'my', Offset: 0, Duration: 3e6, score: 90 }, { Word: 'school', Offset: 4e6, Duration: 5e6, score: 45 }]), 'en-IN')!;
    const detail = parseAzureSegment(
      seg([{ Word: 'my', Offset: 0, Duration: 3e6, score: 80 }, { Word: 'school', Offset: 4.2e6, Duration: 5e6, score: 40, phonemes: [{ Phoneme: 's', score: 30 }, { Phoneme: 'k', score: 50 }] }], { ProsodyScore: 66 }),
      'en-US',
    )!;
    const merged = mergeDetail(primary, detail, 8);
    expect(merged.words[1]!.score).toBe(45); // en-IN word score kept
    expect(merged.words[1]!.phonemes.map((p) => [p.p, p.score])).toEqual([['s', 38], ['k', 58]]);
    expect(merged.scores.prosody).toBe(66);
    expect(merged.scoringLocale).toBe('en-IN+en-US');
  });

  it('does not align words whose text differs between lanes', () => {
    const primary = parseAzureSegment(seg([{ Word: 'prepone', Offset: 0, Duration: 5e6, score: 50 }]), 'en-IN')!;
    const detail = parseAzureSegment(seg([{ Word: 'prepare', Offset: 0, Duration: 5e6, score: 40, phonemes: [{ Phoneme: 'p', score: 10 }] }]), 'en-US')!;
    expect(mergeDetail(primary, detail, 0).words[0]!.phonemes).toEqual([]);
  });

  it('merges segments with duration weighting', () => {
    const a = parseAzureSegment(seg([{ Word: 'hello', Offset: 0, Duration: 1e6, score: 90 }]), 'en-IN')!;
    const b = { ...a, durationMs: 1000, scores: { ...a.scores, fluency: 40 } };
    const m = mergeSegments([a, b], 'en-IN');
    expect(m.text).toBe('hello hello');
    expect(m.scores.fluency).toBeCloseTo((70 * 3000 + 40 * 1000) / 4000);
  });
});
