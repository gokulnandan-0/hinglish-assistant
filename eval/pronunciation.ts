/**
 * Offline pronunciation-policy evaluation (PRD §13): flag precision vs. human labels and false-flag
 * rate on accepted Indian-English variants. Runs on stored assessments (no Azure calls), so it is
 * cheap enough for every threshold/config change.
 *
 * Fixture format (JSONL), one utterance per line:
 *   {"id","l1","age_band","words":[WordResult...],"human":{"flag_words":["sheep"],"accepted_variant_words":["very"]}}
 * Build real fixtures by exporting `turns.scores_json.words` for consented audio and having raters label them.
 */
import { readFileSync } from 'node:fs';
import { loadPronunciationPolicy } from '../src/domain/pronunciation/policy.js';
import { selectPronunciationFocus } from '../src/domain/pronunciation/selector.js';
import type { AgeBand, WordResult } from '../src/domain/types.js';

interface Case {
  id: string;
  l1: string;
  age_band: AgeBand;
  words: WordResult[];
  human: { flag_words: string[]; accepted_variant_words: string[] };
}

export function evaluatePronunciation(path: string) {
  const policy = loadPronunciationPolicy();
  const cases = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Case);
  const byL1 = new Map<string, { tp: number; fp: number; fn: number; variantTotal: number; variantFlagged: number; focusAgree: number; n: number }>();
  for (const c of cases) {
    const r = selectPronunciationFocus(policy, { words: c.words, l1: c.l1, ageBand: c.age_band, profile: [], scripted: false });
    const flagged = new Set(r.flagged.filter((f) => f.severity >= 0.25).map((f) => f.word.toLowerCase()));
    const gold = new Set(c.human.flag_words.map((w) => w.toLowerCase()));
    const m = byL1.get(c.l1) ?? { tp: 0, fp: 0, fn: 0, variantTotal: 0, variantFlagged: 0, focusAgree: 0, n: 0 };
    for (const w of flagged) gold.has(w) ? m.tp++ : m.fp++;
    for (const w of gold) if (!flagged.has(w)) m.fn++;
    for (const w of c.human.accepted_variant_words) {
      m.variantTotal++;
      if (flagged.has(w.toLowerCase())) m.variantFlagged++;
    }
    if ((r.focus && gold.has(r.focus.word.toLowerCase())) || (!r.focus && gold.size === 0)) m.focusAgree++;
    m.n++;
    byL1.set(c.l1, m);
  }
  return [...byL1.entries()].map(([l1, m]) => ({
    l1,
    utterances: m.n,
    flag_precision: m.tp + m.fp ? +(m.tp / (m.tp + m.fp)).toFixed(3) : null,
    flag_recall: m.tp + m.fn ? +(m.tp / (m.tp + m.fn)).toFixed(3) : null,
    false_flag_rate_accepted_variants: m.variantTotal ? +(m.variantFlagged / m.variantTotal).toFixed(3) : null,
    focus_agreement: +(m.focusAgree / m.n).toFixed(3),
  }));
}
