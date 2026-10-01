import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const RuleSchema = z.object({
  id: z.string(),
  kind: z.enum(['phoneme_swap', 'final_consonant_drop', 's_cluster_epenthesis', 'miscue', 'generic_low_score']),
  pairs: z.array(z.tuple([z.string(), z.string()])).optional(),
  errors: z.array(z.string()).optional(),
  impact: z.number().min(0).max(1),
  profileKey: z.string(),
  tip: z.string(),
});

const VariantSchema = z.object({
  id: z.string(),
  expected: z.array(z.string()),
  heard: z.array(z.string()),
  note: z.string().optional(),
});

export const PronunciationPolicySchema = z.object({
  thresholds: z.object({
    default: z.number(),
    byL1: z.record(z.string(), z.number()),
    byAgeBand: z.record(z.string(), z.number()),
    highFrequencyWordThresholdDelta: z.number(),
    drillPass: z.number(),
    drillMaxAttempts: z.number().int(),
    enUsPhonemeCalibration: z.number().default(0),
  }),
  acceptedVariants: z.array(VariantSchema),
  downweighted: z.array(VariantSchema.extend({ weight: z.number().min(0).max(1) })),
  intelligibilityRules: z.array(RuleSchema),
  l1Priority: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.number())])),
  neutralWords: z.object({ words: z.array(z.string()) }),
  highFrequencyWords: z.array(z.string()),
});

export type PronunciationPolicy = z.infer<typeof PronunciationPolicySchema>;
export type IntelligibilityRule = z.infer<typeof RuleSchema>;

export function loadPronunciationPolicy(
  path = resolve(process.env.CONFIG_DIR ?? resolve(process.cwd(), 'config'), 'pronunciation.json'),
): PronunciationPolicy {
  return PronunciationPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function l1PriorityFor(policy: PronunciationPolicy, l1: string, ruleId: string): number {
  const table = policy.l1Priority[l1];
  if (!table || typeof table === 'string') return 1;
  return table[ruleId] ?? 1;
}
