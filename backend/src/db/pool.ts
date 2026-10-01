import pg from 'pg';
import type { Env } from '../config/env.js';

export type Db = pg.Pool;

export function createPool(env: Env): Db {
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    max: 20,
    idleTimeoutMillis: 30_000,
  });
}
