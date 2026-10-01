import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../config/env.js';
import { createPool, type Db } from './pool.js';
import { seedScenarios } from './seed.js';

const MIGRATIONS_DIR = resolve(process.cwd(), 'src/db/migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(loadEnv());
  migrate(db)
    .then(async (ran) => {
      const seeded = await seedScenarios(db);
      console.log(`migrations applied: ${ran.join(', ') || 'none'}; scenarios upserted: ${seeded}`);
    })
    .finally(() => db.end());
}
