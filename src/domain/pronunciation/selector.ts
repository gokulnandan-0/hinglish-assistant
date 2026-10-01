import type { AgeBand, ErrorProfileItem, PhonemeResult, PronunciationFocus, WordResult } from '../types.js';
import { isVowel } from './phonemes.js';
import { l1PriorityFor, type IntelligibilityRule, type PronunciationPolicy } from './policy.js';

export interface SelectorInput {
  words: WordResult[];
  l1: string;
  ageBand: AgeBand;
  profile: ErrorProfileItem[];
  /** Scripted drills report omissions/insertions; unscripted speech cannot. */
  scripted: boolean;
}

export interface FlaggedWord {
  word: string;
  index: number;
  score: number;
  rule: IntelligibilityRule;
  expected: string | null;
  heard: string | null;
  /** 0..1: rule impact × variant weight × how far below threshold. */
  severity: number;
  learnerFrequency: number;
  l1Priority: number;
}

export interface SelectorResult {
  /** The single issue to coach this turn (PRD §10 step 4), or null. */
  focus: PronunciationFocus | null;
  /** All intelligibility-affecting words, for UI highlighting. Accepted variants are excluded. */
  flagged: FlaggedWord[];
  /** Words that scored low but matched an accepted Indian-English variant (for eval/telemetry). */
  acceptedVariantHits: { word: string; variant: string }[];
}

const normalise = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function matches(list: string[], value: string | undefined): boolean {
  if (list.includes('*')) return true;
  return value !== undefined && list.includes(value);
}

export function thresholdFor(policy: PronunciationPolicy, l1: string, ageBand: AgeBand, word: string): number {
  const t = policy.thresholds;
  let threshold = t.byL1[l1] ?? t.default;
  threshold += t.byAgeBand[ageBand] ?? 0;
  if (policy.highFrequencyWords.includes(normalise(word))) threshold += t.highFrequencyWordThresholdDelta;
  return threshold;
}

function matchRule(
  policy: PronunciationPolicy,
  word: WordResult,
  phoneme: PhonemeResult,
  index: number,
  threshold: number,
): { rule: IntelligibilityRule; confidence: number } | null {
  const rules = policy.intelligibilityRules;
  const phones = word.phonemes;
  let best: { rule: IntelligibilityRule; confidence: number } | null = null;
  const consider = (rule: IntelligibilityRule, confidence: number) => {
    if (!best || rule.impact * confidence > best.rule.impact * best.confidence) best = { rule, confidence };
  };

  for (const rule of rules) {
    switch (rule.kind) {
      case 'phoneme_swap':
        for (const [a, b] of rule.pairs ?? []) {
          const isPair = (x: string, y: string | undefined) => (x === a && y === b) || (x === b && y === a);
          if (isPair(phoneme.p, phoneme.heard)) consider(rule, 1);
          // Without NBest "heard" data we only know the expected sound was weak.
          else if (phoneme.heard === undefined && (phoneme.p === a || phoneme.p === b)) consider(rule, 0.6);
        }
        break;
      case 'final_consonant_drop':
        if (index === phones.length - 1 && phones.length > 1 && !isVowel(phoneme.p) && phoneme.score < threshold / 2) {
          consider(rule, 1);
        }
        break;
      case 's_cluster_epenthesis': {
        const second = phones[1];
        if (phones[0]?.p === 's' && second && !isVowel(second.p) && index <= 1) consider(rule, 1);
        break;
      }
      case 'generic_low_score':
        consider(rule, 1);
        break;
      case 'miscue':
        break;
    }
  }
  return best;
}

/**
 * Deterministic pronunciation triage (PRD §10). The LLM never chooses which sound to coach; it only
 * phrases the tip for the issue selected here. That keeps corrections to one per turn and stops the
 * model from "correcting" accepted Indian-English features.
 */
export function selectPronunciationFocus(policy: PronunciationPolicy, input: SelectorInput): SelectorResult {
  const neutral = new Set(policy.neutralWords.words.map(normalise));
  const profileByKey = new Map(input.profile.filter((p) => p.category === 'phoneme').map((p) => [p.key, p]));
  const flagged: FlaggedWord[] = [];
  const acceptedVariantHits: SelectorResult['acceptedVariantHits'] = [];

  input.words.forEach((word, wordIndex) => {
    const key = normalise(word.w);
    if (!key || neutral.has(key)) return;
    const threshold = thresholdFor(policy, input.l1, input.ageBand, word.w);

    if (word.error === 'Omission' || word.error === 'Insertion') {
      if (!input.scripted || word.error === 'Insertion') return;
      const rule = policy.intelligibilityRules.find((r) => r.kind === 'miscue' && r.errors?.includes('Omission'));
      if (rule) flagged.push(buildFlag(policy, input, word, wordIndex, rule, null, null, rule.impact, profileByKey));
      return;
    }
    if (word.score >= threshold && word.error !== 'Mispronunciation') return;

    let bestForWord: FlaggedWord | null = null;
    word.phonemes.forEach((ph, i) => {
      if (ph.score >= threshold) return;
      const accepted = policy.acceptedVariants.find((v) => v.expected.includes(ph.p) && matches(v.heard, ph.heard));
      if (accepted) {
        acceptedVariantHits.push({ word: word.w, variant: accepted.id });
        return;
      }
      const down = policy.downweighted.find(
        (v) => v.expected.includes(ph.p) && (ph.heard === undefined || matches(v.heard, ph.heard)),
      );
      const match = matchRule(policy, word, ph, i, threshold);
      if (!match) return;
      const gap = Math.min(1, Math.max(0, (threshold - ph.score) / threshold));
      const severity = match.rule.impact * match.confidence * (down?.weight ?? 1) * (0.5 + 0.5 * gap);
      const flag = buildFlag(policy, input, word, wordIndex, match.rule, ph.p, ph.heard ?? null, severity, profileByKey);
      if (!bestForWord || flag.severity > bestForWord.severity) bestForWord = flag;
    });

    // Low word score but no individual phoneme under threshold (e.g. stress/timing): generic, low weight.
    if (!bestForWord && word.phonemes.length === 0 && word.score < threshold) {
      const generic = policy.intelligibilityRules.find((r) => r.kind === 'generic_low_score');
      if (generic) bestForWord = buildFlag(policy, input, word, wordIndex, generic, null, null, generic.impact * 0.5, profileByKey);
    }
    if (bestForWord) flagged.push(bestForWord);
  });

  // Rank: intelligibility impact > frequency in this learner's speech > L1 priority table (PRD §10.3).
  const ranked = [...flagged].sort(
    (a, b) =>
      bucket(b.severity) - bucket(a.severity) ||
      b.learnerFrequency - a.learnerFrequency ||
      b.l1Priority - a.l1Priority ||
      a.score - b.score,
  );
  const top = ranked[0];
  const focus: PronunciationFocus | null = top
    ? {
        word: top.word,
        score: Math.round(top.score),
        expected: top.expected,
        heard: top.heard,
        rule: top.rule.id,
        profileKey: top.rule.profileKey,
      }
    : null;
  return { focus, flagged, acceptedVariantHits };
}

/** Coarse buckets so small severity differences defer to learner frequency and L1 priority. */
const bucket = (severity: number) => Math.round(severity * 5);

function buildFlag(
  policy: PronunciationPolicy,
  input: SelectorInput,
  word: WordResult,
  index: number,
  rule: IntelligibilityRule,
  expected: string | null,
  heard: string | null,
  severity: number,
  profileByKey: Map<string, ErrorProfileItem>,
): FlaggedWord {
  const prior = profileByKey.get(rule.profileKey);
  return {
    word: word.w,
    index,
    score: word.score,
    rule,
    expected,
    heard,
    severity,
    learnerFrequency: prior ? Math.min(1, prior.count / 10) * (1 - prior.mastery) : 0,
    l1Priority: l1PriorityFor(policy, input.l1, rule.id),
  };
}

/** Human-readable description of the swap for the LLM prompt ("/θ/ sounded like /t/"). */
export function describeFocus(focus: PronunciationFocus, policy: PronunciationPolicy): string {
  const rule = policy.intelligibilityRules.find((r) => r.id === focus.rule);
  const swap =
    focus.expected && focus.heard
      ? `/${focus.expected}/ sounded like /${focus.heard}/`
      : focus.expected
        ? `/${focus.expected}/ was unclear`
        : 'the word was unclear';
  return `${focus.word} (score ${focus.score}): ${swap}${rule?.tip ? `; coaching hint: ${rule.tip}` : ''}`;
}
