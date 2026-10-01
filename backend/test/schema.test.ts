import { describe, expect, it } from 'vitest';
import { parseTutorOutput } from '../src/domain/tutor/schema.js';
import { deriveObservations, topErrors, updateMastery } from '../src/domain/profile/mastery.js';

const valid = {
  safety_flag: 'none',
  correction: { original: 'He go', fixed: 'He goes', why: 'he → goes', key: 'Grammar: Subject Verb' },
  reply: 'Nice! We say "he goes". Where does he go?',
  pron_tip: { word: 'school', tip: 'Start with s.' },
  next_prompt: 'Where does he go?',
  practised_correctly: ['grammar:articles', 'bad key!'],
  scene_complete: false,
};

describe('parseTutorOutput', () => {
  it('sanitises keys and drops invalid practised keys', () => {
    const out = parseTutorOutput(JSON.stringify(valid), 'school')!;
    expect(out.correction?.key).toBe('grammar:subject_verb');
    expect(out.practised_correctly).toEqual(['grammar:articles']);
    expect(out.pron_tip?.word).toBe('school');
  });

  it('falls back to grammar:other for unusable keys', () => {
    const out = parseTutorOutput(JSON.stringify({ ...valid, correction: { ...valid.correction, key: '???' } }), null)!;
    expect(out.correction?.key).toBe('grammar:other');
  });

  it('drops pron tips for words the selector did not choose', () => {
    expect(parseTutorOutput(JSON.stringify(valid), 'think')!.pron_tip).toBeNull();
    expect(parseTutorOutput(JSON.stringify(valid), null)!.pron_tip).toBeNull();
  });

  it('drops no-op corrections', () => {
    const out = parseTutorOutput(JSON.stringify({ ...valid, correction: { ...valid.correction, fixed: 'he go.' } }), null)!;
    expect(out.correction).toBeNull();
  });

  it('returns null for invalid JSON or schema', () => {
    expect(parseTutorOutput('{"reply": "hi"', null)).toBeNull();
    expect(parseTutorOutput(JSON.stringify({ reply: 'hi' }), null)).toBeNull();
  });
});

describe('mastery', () => {
  it('applies the PRD EMA', () => {
    expect(updateMastery(0.5, true)).toBeCloseTo(0.6);
    expect(updateMastery(0.5, false)).toBeCloseTo(0.4);
  });

  it('surfaces lowest-mastery items', () => {
    const items = [
      { category: 'grammar' as const, key: 'grammar:a', count: 3, lastSeen: '', mastery: 0.7 },
      { category: 'phoneme' as const, key: 'phoneme:θ', count: 5, lastSeen: '', mastery: 0.2 },
      { category: 'grammar' as const, key: 'grammar:b', count: 1, lastSeen: '', mastery: 0.95 },
    ];
    expect(topErrors(items).map((i) => i.key)).toEqual(['phoneme:θ', 'grammar:a']);
  });

  it('records correct use of tracked phonemes', () => {
    const obs = deriveObservations({
      flaggedKeys: [],
      grammarKey: 'grammar:past_simple',
      practisedCorrectly: [],
      producedPhonemes: new Map([['i', 85], ['ɪ', 80]]),
      threshold: 60,
      profile: [{ category: 'phoneme', key: 'phoneme:i-ɪ', count: 2, lastSeen: '', mastery: 0.3 }],
    });
    expect(obs).toEqual([
      { category: 'grammar', key: 'grammar:past_simple', correct: false },
      { category: 'phoneme', key: 'phoneme:i-ɪ', correct: true },
    ]);
  });
});
