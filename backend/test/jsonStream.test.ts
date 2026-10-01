import { describe, expect, it } from 'vitest';
import { TopLevelJsonStream } from '../src/domain/tutor/jsonStream.js';

function run(json: string, chunkSize: number) {
  const members: Record<string, string> = {};
  let reply = '';
  const s = new TopLevelJsonStream({
    onMember: (k, raw) => (members[k] = raw),
    onStringDelta: (k, t) => {
      if (k === 'reply') reply += t;
    },
  });
  for (let i = 0; i < json.length; i += chunkSize) s.write(json.slice(i, i + chunkSize));
  return { members, reply, finished: s.finished };
}

const sample = {
  safety_flag: 'none',
  correction: { original: 'I go yesterday', fixed: 'I went yesterday', why: 'past "went"', key: 'grammar:past_simple' },
  reply: 'Great story! We say "I went" for yesterday.\nWhat did you eat? é \\ done',
  pron_tip: null,
  next_prompt: 'What did you eat?',
  practised_correctly: ['grammar:articles'],
  scene_complete: false,
};

describe('TopLevelJsonStream', () => {
  for (const size of [1, 3, 7, 1000]) {
    it(`streams reply and emits members (chunk=${size})`, () => {
      const json = JSON.stringify(sample, null, size === 3 ? 2 : undefined);
      const { members, reply, finished } = run(json, size);
      expect(reply).toBe(sample.reply);
      expect(finished).toBe(true);
      for (const [k, v] of Object.entries(sample)) expect(JSON.parse(members[k]!)).toEqual(v);
    });
  }

  it('emits correction before reply starts streaming', () => {
    const order: string[] = [];
    const s = new TopLevelJsonStream({
      onMember: (k) => order.push(`member:${k}`),
      onStringDelta: () => {
        if (order.at(-1) !== 'delta') order.push('delta');
      },
    });
    s.write(JSON.stringify(sample));
    expect(order.slice(0, 3)).toEqual(['member:safety_flag', 'member:correction', 'delta']);
  });

  it('decodes unicode escapes', () => {
    const { reply } = run('{"reply":"chai \\u2615 time"}', 2);
    expect(reply).toBe('chai ☕ time');
  });
});
