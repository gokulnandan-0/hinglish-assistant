import { describe, expect, it } from 'vitest';
import { SentenceSplitter } from '../src/domain/tutor/sentenceSplitter.js';

const split = (text: string, step = 4) => {
  const out: string[] = [];
  const s = new SentenceSplitter((x) => out.push(x));
  for (let i = 0; i < text.length; i += step) s.push(text.slice(i, i + step));
  s.flush();
  return out;
};

describe('SentenceSplitter', () => {
  it('splits on sentence ends while streaming', () => {
    expect(split('Wonderful, you used past tense well! Now tell me, what did Mr. Sharma say? I am curious.')).toEqual([
      'Wonderful, you used past tense well!',
      'Now tell me, what did Mr. Sharma say?',
      'I am curious.',
    ]);
  });

  it('does not emit a tiny first sentence on a full stop', () => {
    expect(split('Nice. You said it clearly. Try again?')).toEqual(['Nice. You said it clearly.', 'Try again?']);
  });

  it('keeps decimals together', () => {
    expect(split('It costs 3.5 rupees more than the other chai stall. OK?')).toEqual(['It costs 3.5 rupees more than the other chai stall.', 'OK?']);
  });

  it('flushes long clauses at a comma', () => {
    const out = split('When you go to the railway station early in the morning with your family, remember to carry your ticket and ID');
    expect(out.length).toBe(2);
    expect(out[0]!.endsWith(',')).toBe(true);
  });
});
