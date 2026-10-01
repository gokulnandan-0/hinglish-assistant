import type { ErrorCategory, ErrorProfileItem } from '../types.js';

/** PRD §8: exponential moving average of correct/incorrect observations. */
export function updateMastery(mastery: number, correct: boolean): number {
  return 0.8 * mastery + 0.2 * (correct ? 1 : 0);
}

export interface ProfileObservation {
  category: ErrorCategory;
  key: string;
  correct: boolean;
}

/** Top-N lowest-mastery items to surface in the tutor prompt (PRD §8: top 3). */
export function topErrors(items: ErrorProfileItem[], n = 3): ErrorProfileItem[] {
  return [...items]
    .filter((i) => i.count > 0 && i.mastery < 0.9)
    .sort((a, b) => a.mastery - b.mastery || b.count - a.count)
    .slice(0, n);
}

export function formatTopErrors(items: ErrorProfileItem[]): string {
  if (items.length === 0) return 'none yet';
  return items.map((i) => `${i.key} (seen ${i.count}x, mastery ${i.mastery.toFixed(2)})`).join('; ');
}

export const INITIAL_MASTERY = 0.5;

/** Phonemes that exercise a phoneme profile key, e.g. `phoneme:i-ɪ` → {i, ɪ}; `phoneme:θ` → {θ}. */
export function phonemesForKey(key: string): string[] | null {
  if (!key.startsWith('phoneme:')) return null;
  const body = key.slice('phoneme:'.length);
  if (['final_consonant', 's_cluster', 'omission', 'generic'].includes(body)) return null;
  return body.split('-');
}

/**
 * Derive this turn's profile observations:
 *  - every flagged issue / grammar correction is an incorrect observation;
 *  - a tracked phoneme key that the learner produced above threshold (and was not flagged) is a correct one;
 *  - tracked grammar/vocab keys the LLM reports as used correctly are correct ones.
 */
export function deriveObservations(args: {
  flaggedKeys: string[];
  grammarKey: string | null;
  practisedCorrectly: string[];
  producedPhonemes: Map<string, number>;
  threshold: number;
  profile: ErrorProfileItem[];
}): ProfileObservation[] {
  const out = new Map<string, ProfileObservation>();
  for (const key of args.flaggedKeys) out.set(key, { category: 'phoneme', key, correct: false });
  if (args.grammarKey) {
    const category: ErrorCategory = args.grammarKey.startsWith('vocab:') ? 'vocab' : 'grammar';
    out.set(args.grammarKey, { category, key: args.grammarKey, correct: false });
  }
  const tracked = new Set(args.profile.map((p) => p.key));
  for (const item of args.profile) {
    if (out.has(item.key) || item.category !== 'phoneme') continue;
    const phones = phonemesForKey(item.key);
    if (!phones) continue;
    const scores = phones.map((p) => args.producedPhonemes.get(p)).filter((s): s is number => s !== undefined);
    if (scores.length > 0 && Math.min(...scores) >= args.threshold) {
      out.set(item.key, { category: 'phoneme', key: item.key, correct: true });
    }
  }
  for (const key of args.practisedCorrectly) {
    if (!tracked.has(key) || out.has(key)) continue;
    out.set(key, { category: key.startsWith('vocab:') ? 'vocab' : 'grammar', key, correct: true });
  }
  return [...out.values()];
}
