import { createHash } from 'node:crypto';
import type { AgeBand, Cefr, ErrorProfileItem, Learner, Scenario, Session, SessionMode, SessionSummary } from '../domain/types.js';
import { INITIAL_MASTERY, updateMastery, type ProfileObservation } from '../domain/profile/mastery.js';
import type { Db } from './pool.js';

interface LearnerRow {
  id: string;
  external_subject: string;
  display_name: string | null;
  age_band: AgeBand;
  l1: string;
  cefr_level: Cefr;
  consent_parental: boolean;
  consent_parental_at: Date | null;
  consent_audio_storage: boolean;
  preferred_voice: 'conversation' | 'clear';
  created_at: Date;
  streak_days: number;
}

const toLearner = (r: LearnerRow): Learner => ({
  id: r.id,
  externalSubject: r.external_subject,
  displayName: r.display_name,
  ageBand: r.age_band,
  l1: r.l1,
  cefrLevel: r.cefr_level,
  consent: {
    parental: r.consent_parental,
    parentalVerifiedAt: r.consent_parental_at?.toISOString() ?? null,
    audioStorage: r.consent_audio_storage,
  },
  preferredVoice: r.preferred_voice,
  createdAt: r.created_at.toISOString(),
});

export interface CreateLearnerInput {
  externalSubject: string;
  displayName?: string | null;
  ageBand: AgeBand;
  l1: string;
  cefrLevel: Cefr;
  consent: { parental: boolean; parentalConsentRef?: string | null; audioStorage: boolean };
  preferredVoice?: 'conversation' | 'clear';
}

export class Repo {
  constructor(private readonly db: Db) {}

  async createLearner(input: CreateLearnerInput): Promise<Learner> {
    const { rows } = await this.db.query<LearnerRow>(
      `INSERT INTO learners (external_subject, display_name, age_band, l1, cefr_level, consent_parental, consent_parental_at,
                             consent_parental_ref, consent_audio_storage, preferred_voice)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN now() END, $7, $8, $9)
       RETURNING *`,
      [
        input.externalSubject,
        input.displayName ?? null,
        input.ageBand,
        input.l1,
        input.cefrLevel,
        input.consent.parental,
        input.consent.parentalConsentRef ?? null,
        input.consent.audioStorage,
        input.preferredVoice ?? 'conversation',
      ],
    );
    return toLearner(rows[0]!);
  }

  async getLearner(id: string): Promise<Learner | null> {
    const { rows } = await this.db.query<LearnerRow>('SELECT * FROM learners WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows[0] ? toLearner(rows[0]) : null;
  }

  async getLearnerBySubject(sub: string): Promise<Learner | null> {
    const { rows } = await this.db.query<LearnerRow>('SELECT * FROM learners WHERE external_subject = $1 AND deleted_at IS NULL', [sub]);
    return rows[0] ? toLearner(rows[0]) : null;
  }

  async getStreak(learnerId: string): Promise<number> {
    const { rows } = await this.db.query<{ streak_days: number; last_active_date: Date | null }>(
      'SELECT streak_days, last_active_date FROM learners WHERE id = $1',
      [learnerId],
    );
    const r = rows[0];
    if (!r?.last_active_date) return 0;
    const days = Math.floor((Date.now() - r.last_active_date.getTime()) / 86_400_000);
    return days <= 1 ? r.streak_days : 0;
  }

  /** Called once per session start; dates are evaluated in IST, the product's home timezone. */
  async touchStreak(learnerId: string): Promise<void> {
    await this.db.query(
      `UPDATE learners SET
         streak_days = CASE
           WHEN last_active_date = (now() AT TIME ZONE 'Asia/Kolkata')::date THEN streak_days
           WHEN last_active_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 1 THEN streak_days + 1
           ELSE 1 END,
         last_active_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
       WHERE id = $1`,
      [learnerId],
    );
  }

  async listScenarios(filter: { level?: Cefr; audience?: 'kids' | 'adults' }): Promise<Scenario[]> {
    const params: unknown[] = [];
    const where = ['active'];
    if (filter.level) {
      params.push(filter.level);
      where.push(`level = $${params.length}`);
    }
    if (filter.audience) {
      params.push(filter.audience);
      where.push(`audience IN ('all', $${params.length})`);
    }
    const { rows } = await this.db.query(`SELECT * FROM scenarios WHERE ${where.join(' AND ')} ORDER BY level, title`, params);
    return rows.map(toScenario);
  }

  async getScenario(id: string): Promise<Scenario | null> {
    const { rows } = await this.db.query('SELECT * FROM scenarios WHERE id = $1 AND active', [id]);
    return rows[0] ? toScenario(rows[0]) : null;
  }

  async createSession(learnerId: string, mode: SessionMode, scenarioId: string | null): Promise<Session> {
    const { rows } = await this.db.query(
      'INSERT INTO sessions (learner_id, mode, scenario_id) VALUES ($1,$2,$3) RETURNING *',
      [learnerId, mode, scenarioId],
    );
    return toSession(rows[0]);
  }

  async getSession(id: string): Promise<Session | null> {
    const { rows } = await this.db.query('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async endSession(id: string, summary: SessionSummary | null): Promise<void> {
    await this.db.query('UPDATE sessions SET ended_at = COALESCE(ended_at, now()), summary_json = COALESCE($2, summary_json) WHERE id = $1', [
      id,
      summary ? JSON.stringify(summary) : null,
    ]);
  }

  async insertTurn(t: {
    sessionId: string;
    seq: number;
    transcript: string;
    reference: string | null;
    scores: unknown;
    llm: unknown;
    latency: unknown;
    cost: unknown;
    promptVersion: string;
    audioUrl: string | null;
    audioExpiresAt: Date | null;
  }): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO turns (session_id, seq, transcript, reference, scores_json, llm_json, latency_json, cost_json, prompt_version, audio_url, audio_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        t.sessionId,
        t.seq,
        t.transcript,
        t.reference,
        JSON.stringify(t.scores),
        t.llm === null ? null : JSON.stringify(t.llm),
        JSON.stringify(t.latency),
        t.cost === null ? null : JSON.stringify(t.cost),
        t.promptVersion,
        t.audioUrl,
        t.audioExpiresAt,
      ],
    );
    return rows[0]!.id;
  }

  async listTurns(sessionId: string): Promise<{ seq: number; transcript: string; scores: any; llm: any }[]> {
    const { rows } = await this.db.query(
      'SELECT seq, transcript, scores_json AS scores, llm_json AS llm FROM turns WHERE session_id = $1 ORDER BY seq',
      [sessionId],
    );
    return rows;
  }

  async nextTurnSeq(sessionId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE session_id = $1', [sessionId]);
    return rows[0]!.n;
  }

  async getErrorProfile(learnerId: string): Promise<ErrorProfileItem[]> {
    const { rows } = await this.db.query(
      'SELECT category, key, count, last_seen, mastery FROM error_profile WHERE learner_id = $1',
      [learnerId],
    );
    return rows.map((r) => ({ category: r.category, key: r.key, count: r.count, lastSeen: r.last_seen.toISOString(), mastery: Number(r.mastery) }));
  }

  /** Applies PRD §8 mastery EMA atomically per key. */
  async applyObservations(learnerId: string, obs: ProfileObservation[]): Promise<void> {
    if (obs.length === 0) return;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      for (const o of obs) {
        const { rows } = await client.query<{ mastery: number }>(
          'SELECT mastery FROM error_profile WHERE learner_id = $1 AND key = $2 FOR UPDATE',
          [learnerId, o.key],
        );
        const current = rows[0] ? Number(rows[0].mastery) : INITIAL_MASTERY;
        // A "correct" observation for an item we have never seen as an error isn't worth tracking.
        if (!rows[0] && o.correct) continue;
        const next = updateMastery(current, o.correct);
        await client.query(
          `INSERT INTO error_profile (learner_id, category, key, count, last_seen, mastery)
           VALUES ($1,$2,$3,$4, now(), $5)
           ON CONFLICT (learner_id, key) DO UPDATE SET
             count = error_profile.count + $4, last_seen = now(), mastery = $5`,
          [learnerId, o.category, o.key, o.correct ? 0 : 1, next],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** DPDP deletion: returns blob URLs the caller must delete from storage. */
  async deleteLearnerData(learnerId: string): Promise<{ audioUrls: string[]; requestId: string }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: audio } = await client.query<{ audio_url: string }>(
        `SELECT t.audio_url FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.learner_id = $1 AND t.audio_url IS NOT NULL`,
        [learnerId],
      );
      const hash = createHash('sha256').update(learnerId).digest('hex');
      const { rows: req } = await client.query<{ id: string }>(
        'INSERT INTO deletion_requests (learner_hash) VALUES ($1) RETURNING id',
        [hash],
      );
      // Cascades to sessions, turns, error_profile.
      await client.query('DELETE FROM learners WHERE id = $1', [learnerId]);
      await client.query('COMMIT');
      return { audioUrls: audio.map((a) => a.audio_url), requestId: req[0]!.id };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async completeDeletion(requestId: string, blobsDeleted: number): Promise<void> {
    await this.db.query('UPDATE deletion_requests SET completed_at = now(), blobs_deleted = $2 WHERE id = $1', [requestId, blobsDeleted]);
  }

  async expiredAudio(limit = 500): Promise<{ id: string; audio_url: string }[]> {
    const { rows } = await this.db.query(
      'SELECT id, audio_url FROM turns WHERE audio_url IS NOT NULL AND audio_expires_at < now() LIMIT $1',
      [limit],
    );
    return rows;
  }

  async clearAudio(turnId: string): Promise<void> {
    await this.db.query('UPDATE turns SET audio_url = NULL, audio_expires_at = NULL WHERE id = $1', [turnId]);
  }
}

function toScenario(r: any): Scenario {
  return {
    id: r.id,
    title: r.title,
    level: r.level,
    role: r.role,
    goal: r.goal,
    targetVocab: r.target_vocab,
    openingLine: r.opening_line,
    safetyNotes: r.safety_notes,
    audience: r.audience,
  };
}

function toSession(r: any): Session {
  return {
    id: r.id,
    learnerId: r.learner_id,
    mode: r.mode,
    scenarioId: r.scenario_id,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at?.toISOString() ?? null,
    summary: r.summary_json,
  };
}
