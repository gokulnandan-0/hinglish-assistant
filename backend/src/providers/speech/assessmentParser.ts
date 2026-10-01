import type { PhonemeResult, UtteranceAssessment, WordErrorType, WordResult } from '../../domain/types.js';
import { toIpa } from '../../domain/pronunciation/phonemes.js';

/** Shape of `SpeechServiceResponse_JsonResult` with pronunciation assessment enabled (subset we use). */
interface AzurePaJson {
  RecognitionStatus?: string;
  DisplayText?: string;
  Offset?: number;
  Duration?: number;
  NBest?: {
    Display?: string;
    Lexical?: string;
    PronunciationAssessment?: {
      AccuracyScore?: number;
      FluencyScore?: number;
      CompletenessScore?: number;
      PronScore?: number;
      ProsodyScore?: number;
    };
    Words?: {
      Word: string;
      Offset?: number;
      Duration?: number;
      PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
      Phonemes?: {
        Phoneme?: string;
        Offset?: number;
        Duration?: number;
        PronunciationAssessment?: { AccuracyScore?: number; NBestPhonemes?: { Phoneme: string; Score: number }[] };
      }[];
    }[];
  }[];
}

const TICKS_PER_MS = 10_000;
const LONG_PAUSE_MS = 700;

const ERROR_TYPES = new Set<WordErrorType>(['None', 'Mispronunciation', 'Omission', 'Insertion', 'UnexpectedBreak', 'MissingBreak', 'Monotone']);

/** Parse one recognised segment's JSON into our vendor-neutral assessment. */
export function parseAzureSegment(json: string, locale: string): UtteranceAssessment | null {
  let data: AzurePaJson;
  try {
    data = JSON.parse(json) as AzurePaJson;
  } catch {
    return null;
  }
  if (data.RecognitionStatus && data.RecognitionStatus !== 'Success') return null;
  const best = data.NBest?.[0];
  if (!best) return null;

  const words: WordResult[] = (best.Words ?? []).map((w) => {
    const err = (w.PronunciationAssessment?.ErrorType ?? 'None') as WordErrorType;
    return {
      w: w.Word,
      score: w.PronunciationAssessment?.AccuracyScore ?? 0,
      error: ERROR_TYPES.has(err) ? err : 'None',
      offsetMs: w.Offset !== undefined ? w.Offset / TICKS_PER_MS : undefined,
      durationMs: w.Duration !== undefined ? w.Duration / TICKS_PER_MS : undefined,
      phonemes: (w.Phonemes ?? []).map((p): PhonemeResult => {
        const expected = p.Phoneme ? toIpa(p.Phoneme) : '';
        const top = p.PronunciationAssessment?.NBestPhonemes?.[0];
        const heard = top ? toIpa(top.Phoneme) : undefined;
        return {
          p: expected,
          score: p.PronunciationAssessment?.AccuracyScore ?? 0,
          ...(heard && heard !== expected ? { heard } : {}),
        };
      }),
    };
  });

  const pa = best.PronunciationAssessment ?? {};
  return {
    text: data.DisplayText ?? best.Display ?? '',
    words,
    scores: {
      accuracy: pa.AccuracyScore ?? null,
      fluency: pa.FluencyScore ?? null,
      completeness: pa.CompletenessScore ?? null,
      prosody: pa.ProsodyScore ?? null,
      pronunciation: pa.PronScore ?? null,
    },
    longPauses: countLongPauses(words),
    durationMs: (data.Duration ?? 0) / TICKS_PER_MS,
    scoringLocale: locale,
  };
}

function countLongPauses(words: WordResult[]): number {
  let n = 0;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    if (prev.offsetMs === undefined || prev.durationMs === undefined || cur.offsetMs === undefined) continue;
    if (cur.offsetMs - (prev.offsetMs + prev.durationMs) > LONG_PAUSE_MS) n++;
  }
  return n;
}

/** Merge continuous-recognition segments into one utterance; scores are duration-weighted. */
export function mergeSegments(segments: UtteranceAssessment[], locale: string): UtteranceAssessment {
  const nonEmpty = segments.filter((s) => s.text.trim() || s.words.length);
  const total = nonEmpty.reduce((a, s) => a + Math.max(1, s.durationMs), 0);
  const weighted = (pick: (s: UtteranceAssessment) => number | null): number | null => {
    let sum = 0;
    let weight = 0;
    for (const s of nonEmpty) {
      const v = pick(s);
      if (v === null) continue;
      const w = Math.max(1, s.durationMs);
      sum += v * w;
      weight += w;
    }
    return weight ? sum / weight : null;
  };
  const words = nonEmpty.flatMap((s) => s.words);
  return {
    text: nonEmpty.map((s) => s.text.trim()).filter(Boolean).join(' '),
    words,
    scores: {
      accuracy: weighted((s) => s.scores.accuracy),
      fluency: weighted((s) => s.scores.fluency),
      completeness: weighted((s) => s.scores.completeness),
      prosody: weighted((s) => s.scores.prosody),
      pronunciation: weighted((s) => s.scores.pronunciation),
    },
    longPauses: nonEmpty.reduce((a, s) => a + s.longPauses, 0) + Math.max(0, nonEmpty.length - 1),
    durationMs: total,
    scoringLocale: locale,
  };
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Enrich the en-IN assessment (accent-tolerant transcript + word scores) with en-US phoneme detail
 * (IPA names, NBest "heard" phonemes, prosody), which en-IN does not provide.
 *
 * Alignment: both recognisers see the same audio timeline, so words are matched by time overlap and
 * accepted only when the normalised text agrees; otherwise the en-IN word keeps its own phonemes.
 * en-US phoneme scores are shifted by `calibration` because the en-US acoustic model is harsher on
 * Indian-accented speech; calibrate against human ratings (PRD §13).
 */
export function mergeDetail(primary: UtteranceAssessment, detail: UtteranceAssessment | null, calibration: number): UtteranceAssessment {
  if (!detail) return primary;
  const used = new Set<number>();
  const words = primary.words.map((w) => {
    const match = findAligned(w, detail.words, used);
    if (match < 0) return w;
    used.add(match);
    const d = detail.words[match]!;
    return {
      ...w,
      phonemes: d.phonemes.map((p) => ({ ...p, score: Math.min(100, p.score + calibration) })),
    };
  });
  return {
    ...primary,
    words,
    scores: { ...primary.scores, prosody: detail.scores.prosody ?? primary.scores.prosody },
    scoringLocale: `${primary.scoringLocale}+${detail.scoringLocale}`,
  };
}

function findAligned(w: WordResult, candidates: WordResult[], used: Set<number>): number {
  const key = norm(w.w);
  let best = -1;
  let bestOverlap = 0;
  candidates.forEach((c, i) => {
    if (used.has(i) || norm(c.w) !== key) return;
    if (w.offsetMs === undefined || c.offsetMs === undefined) {
      if (best < 0) best = i;
      return;
    }
    const start = Math.max(w.offsetMs, c.offsetMs);
    const end = Math.min(w.offsetMs + (w.durationMs ?? 0), c.offsetMs + (c.durationMs ?? 0));
    const overlap = end - start;
    // Allow small gaps (different segmentation) as a weak match.
    const score = overlap > 0 ? overlap : Math.abs(w.offsetMs - c.offsetMs) < 300 ? 1 : 0;
    if (score > bestOverlap) {
      bestOverlap = score;
      best = i;
    }
  });
  return best;
}

export function emptyAssessment(locale: string): UtteranceAssessment {
  return {
    text: '',
    words: [],
    scores: { accuracy: null, fluency: null, completeness: null, prosody: null, pronunciation: null },
    longPauses: 0,
    durationMs: 0,
    scoringLocale: locale,
  };
}
