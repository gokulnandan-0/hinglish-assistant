import { describe, expect, it } from 'vitest';
import { loadPronunciationPolicy } from '../src/domain/pronunciation/policy.js';
import { selectPronunciationFocus } from '../src/domain/pronunciation/selector.js';
import type { WordResult } from '../src/domain/types.js';

const policy = loadPronunciationPolicy();
const word = (w: string, score: number, phonemes: [string, number, string?][], error: WordResult['error'] = 'Mispronunciation'): WordResult => ({
  w,
  score,
  error,
  phonemes: phonemes.map(([p, s, heard]) => ({ p, score: s, ...(heard ? { heard } : {}) })),
});
const base = { l1: 'hi', ageBand: 'adult' as const, profile: [], scripted: false };

describe('selectPronunciationFocus', () => {
  it('does not flag accepted Indian-English variants (v/w merger, retroflex t)', () => {
    const r = selectPronunciationFocus(policy, {
      ...base,
      words: [word('very', 45, [['v', 30, 'w'], ['ɛ', 90], ['r', 80], ['i', 90]]), word('water', 50, [['w', 80], ['ɔ', 85], ['t', 35], ['ɝ', 70]])],
    });
    expect(r.focus).toBeNull();
    expect(r.acceptedVariantHits.map((h) => h.variant).sort()).toEqual(['retroflex-t', 'v-w-merger']);
  });

  it('prefers an intelligibility swap (ship/sheep) over a downweighted dental /θ/', () => {
    const r = selectPronunciationFocus(policy, {
      ...base,
      words: [word('think', 40, [['θ', 20, 't'], ['ɪ', 90], ['ŋ', 90], ['k', 90]]), word('sheep', 45, [['ʃ', 90], ['i', 25, 'ɪ'], ['p', 90]])],
    });
    expect(r.focus?.word).toBe('sheep');
    expect(r.focus?.rule).toBe('vowel-length-i');
    expect(r.focus?.heard).toBe('ɪ');
  });

  it('ignores Hinglish neutral words and high scores', () => {
    const r = selectPronunciationFocus(policy, {
      ...base,
      words: [word('chai', 10, [['tʃ', 10]]), word('school', 95, [['s', 95], ['k', 95], ['u', 95], ['l', 95]], 'None')],
    });
    expect(r.focus).toBeNull();
    expect(r.flagged).toHaveLength(0);
  });

  it('detects s-cluster epenthesis and dropped final consonants', () => {
    const r = selectPronunciationFocus(policy, {
      ...base,
      words: [word('school', 40, [['s', 30], ['k', 50], ['u', 90], ['l', 90]]), word('hand', 50, [['h', 90], ['æ', 90], ['n', 90], ['d', 10]])],
    });
    const rules = r.flagged.map((f) => f.rule.id).sort();
    expect(rules).toContain('s-cluster');
    // final /d/ in "hand" is also a retroflex-d accepted variant; must NOT be flagged
    expect(rules).not.toContain('final-consonant');
  });

  it('uses learner history to break ties', () => {
    const words = [word('zoo', 40, [['z', 30, 'dʒ'], ['u', 90]]), word('ship', 40, [['ʃ', 90], ['ɪ', 30, 'i'], ['p', 90]])];
    const r = selectPronunciationFocus(policy, {
      ...base,
      l1: 'xx',
      words,
      profile: [{ category: 'phoneme', key: 'phoneme:i-ɪ', count: 9, lastSeen: '', mastery: 0.2 }],
    });
    expect(r.focus?.word).toBe('ship');
  });

  it('flags omissions only in scripted drills', () => {
    const omitted = word('the', 0, [], 'Omission');
    expect(selectPronunciationFocus(policy, { ...base, words: [omitted], scripted: true }).focus?.rule).toBe('word-omission');
    expect(selectPronunciationFocus(policy, { ...base, words: [omitted], scripted: false }).flagged).toHaveLength(0);
  });
});
