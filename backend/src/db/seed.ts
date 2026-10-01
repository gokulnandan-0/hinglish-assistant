import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Db } from './pool.js';

const ScenarioSeed = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    level: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
    role: z.string(),
    goal: z.string(),
    targetVocab: z.array(z.string()),
    openingLine: z.string(),
    safetyNotes: z.string().default(''),
    audience: z.enum(['all', 'kids', 'adults']).default('all'),
  }),
);

export async function seedScenarios(db: Db, file = resolve(process.env.CONFIG_DIR ?? resolve(process.cwd(), 'config'), 'scenarios.json')): Promise<number> {
  const scenarios = ScenarioSeed.parse(JSON.parse(readFileSync(file, 'utf8')));
  for (const s of scenarios) {
    await db.query(
      `INSERT INTO scenarios (id, title, level, role, goal, target_vocab, opening_line, safety_notes, audience)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, level=EXCLUDED.level, role=EXCLUDED.role, goal=EXCLUDED.goal,
         target_vocab=EXCLUDED.target_vocab, opening_line=EXCLUDED.opening_line, safety_notes=EXCLUDED.safety_notes, audience=EXCLUDED.audience`,
      [s.id, s.title, s.level, s.role, s.goal, s.targetVocab, s.openingLine, s.safetyNotes, s.audience],
    );
  }
  return scenarios.length;
}
