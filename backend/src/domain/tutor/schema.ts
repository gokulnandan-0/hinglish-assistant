import { z } from 'zod';
import type { TutorOutput } from '../types.js';

/**
 * JSON Schema for Azure OpenAI structured outputs (strict). Property ORDER matters: the model emits
 * keys in schema order, so `safety_flag` and `correction` arrive first (cheap, a few tokens), and
 * `reply` streams next, feeding TTS sentence by sentence.
 */
export const TUTOR_JSON_SCHEMA = {
  name: 'tutor_turn',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['safety_flag', 'correction', 'reply', 'pron_tip', 'next_prompt', 'practised_correctly', 'scene_complete'],
    properties: {
      safety_flag: { type: 'string', enum: ['none', 'self_harm', 'abuse', 'other'] },
      correction: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['original', 'fixed', 'why', 'key'],
            properties: {
              original: { type: 'string' },
              fixed: { type: 'string' },
              why: { type: 'string' },
              key: { type: 'string' },
            },
          },
          { type: 'null' },
        ],
      },
      reply: { type: 'string' },
      pron_tip: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['word', 'tip'],
            properties: { word: { type: 'string' }, tip: { type: 'string' } },
          },
          { type: 'null' },
        ],
      },
      next_prompt: { type: 'string' },
      practised_correctly: { type: 'array', items: { type: 'string' } },
      scene_complete: { type: 'boolean' },
    },
  },
} as const;

const KEY_RE = /^(grammar|vocab):[a-z0-9_]+$/;

export const TutorOutputSchema = z.object({
  safety_flag: z.enum(['none', 'self_harm', 'abuse', 'other']),
  correction: z
    .object({ original: z.string(), fixed: z.string(), why: z.string(), key: z.string() })
    .nullable(),
  reply: z.string().min(1),
  pron_tip: z.object({ word: z.string(), tip: z.string() }).nullable(),
  next_prompt: z.string(),
  practised_correctly: z.array(z.string()),
  scene_complete: z.boolean(),
});

/**
 * Parse + post-validate the model output. Enforces product rules the model might break:
 * - at most one correction, and it must actually change something;
 * - pron_tip only for the word the selector chose;
 * - stable, sanitised profile keys.
 */
export function parseTutorOutput(raw: string, allowedPronWord: string | null): TutorOutput | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = TutorOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  const out = parsed.data;

  let correction = out.correction;
  if (correction) {
    const same = norm(correction.original) === norm(correction.fixed);
    if (same || !correction.fixed.trim()) correction = null;
    else if (!KEY_RE.test(correction.key)) {
      const slug = correction.key
        .toLowerCase()
        .replace(/[^a-z0-9_:]+/g, '_')
        .replace(/_*:_*/g, ':')
        .replace(/^_+|_+$/g, '');
      correction = { ...correction, key: KEY_RE.test(slug) ? slug : 'grammar:other' };
    }
  }

  let pronTip = out.pron_tip;
  if (pronTip && (!allowedPronWord || norm(pronTip.word) !== norm(allowedPronWord))) pronTip = null;

  return {
    reply: out.reply.trim(),
    correction,
    pron_tip: pronTip,
    next_prompt: out.next_prompt.trim(),
    practised_correctly: out.practised_correctly.filter((k) => KEY_RE.test(k)),
    scene_complete: out.scene_complete,
    safety_flag: out.safety_flag,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Plain reply used when the model output fails validation twice (PRD §9). */
export function fallbackOutput(replyText: string | null): TutorOutput {
  const reply = replyText?.trim() || "Nice try! Could you say that again in a different way?";
  return {
    reply,
    correction: null,
    pron_tip: null,
    next_prompt: '',
    practised_correctly: [],
    scene_complete: false,
    safety_flag: 'none',
  };
}
