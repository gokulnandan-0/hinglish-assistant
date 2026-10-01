import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Learner } from '../domain/types.js';
import { topErrors } from '../domain/profile/mastery.js';
import { summariseSession } from '../domain/tutor/summary.js';

const Cefr = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

const CreateLearnerBody = z.object({
  display_name: z.string().max(40).optional(),
  age_band: z.enum(['kid', 'teen', 'adult']),
  l1: z.string().regex(/^[a-z]{2,3}$/),
  level: Cefr.default('A1'),
  preferred_voice: z.enum(['conversation', 'clear']).optional(),
  consent: z.object({
    parental: z.boolean().default(false),
    /** Reference to the verifiable parental-consent record (e.g. OTP to guardian's phone, DigiLocker). */
    parental_consent_ref: z.string().max(200).optional(),
    audio_storage: z.boolean().default(false),
  }),
});

const CreateSessionBody = z.object({
  learner_id: z.string().uuid().optional(),
  mode: z.enum(['tutor', 'roleplay', 'drill']),
  scenario_id: z.string().optional(),
});

const TtsPreviewBody = z.object({
  text: z.string().min(1).max(200),
  voice: z.enum(['conversation', 'clear', 'l1_hint']).default('clear'),
  rate: z.number().min(0.5).max(1.5).optional(),
});

declare module 'fastify' {
  interface FastifyRequest {
    subject: string;
  }
}

const isMinor = (l: Pick<Learner, 'ageBand'>) => l.ageBand !== 'adult';

export function registerRest(app: FastifyInstance, deps: Deps): void {
  const { repo } = deps;

  app.decorateRequest('subject', '');
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    try {
      req.subject = (await deps.verify(h.slice(7))).subject;
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  /** Loads the learner and enforces that it belongs to the caller. */
  const ownLearner = async (req: FastifyRequest, reply: FastifyReply, id: string): Promise<Learner | null> => {
    const learner = await repo.getLearner(id);
    if (!learner || learner.externalSubject !== req.subject) {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return learner;
  };

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await Promise.all([deps.db.query('SELECT 1'), deps.redis.ping()]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.register(async (r) => {
    r.addHook('onRequest', auth);

    r.post('/v1/learners', async (req, reply) => {
      const body = CreateLearnerBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      const b = body.data;
      // DPDP Act 2023 §9: verifiable parental consent before processing a child's data.
      if (isMinor({ ageBand: b.age_band }) && (!b.consent.parental || !b.consent.parental_consent_ref)) {
        return reply.code(422).send({ error: 'parental_consent_required' });
      }
      if (await repo.getLearnerBySubject(req.subject)) return reply.code(409).send({ error: 'learner_exists' });
      const learner = await repo.createLearner({
        externalSubject: req.subject,
        displayName: b.display_name ?? null,
        ageBand: b.age_band,
        l1: b.l1,
        cefrLevel: b.level,
        consent: { parental: b.consent.parental, parentalConsentRef: b.consent.parental_consent_ref ?? null, audioStorage: b.consent.audio_storage },
        preferredVoice: b.preferred_voice,
      });
      return reply.code(201).send(publicLearner(learner));
    });

    r.get<{ Params: { id: string } }>('/v1/learners/:id/profile', async (req, reply) => {
      const learner = await ownLearner(req, reply, req.params.id);
      if (!learner) return;
      const [profile, streak] = await Promise.all([repo.getErrorProfile(learner.id), repo.getStreak(learner.id)]);
      return {
        ...publicLearner(learner),
        streak_days: streak,
        top_errors: topErrors(profile, 5).map((e) => ({ category: e.category, key: e.key, count: e.count, mastery: Number(e.mastery.toFixed(2)), last_seen: e.lastSeen })),
      };
    });

    r.post('/v1/sessions', async (req, reply) => {
      const body = CreateSessionBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      const learner = body.data.learner_id ? await ownLearner(req, reply, body.data.learner_id) : await repo.getLearnerBySubject(req.subject);
      if (!learner) return reply.sent ? undefined : reply.code(404).send({ error: 'learner_not_found' });
      if (isMinor(learner) && !learner.consent.parental) return reply.code(403).send({ error: 'parental_consent_required' });

      let scenarioId: string | null = null;
      if (body.data.mode === 'roleplay') {
        if (!body.data.scenario_id) return reply.code(400).send({ error: 'scenario_required' });
        const scenario = await repo.getScenario(body.data.scenario_id);
        if (!scenario) return reply.code(404).send({ error: 'scenario_not_found' });
        if ((scenario.audience === 'adults' && learner.ageBand === 'kid') || (scenario.audience === 'kids' && learner.ageBand === 'adult')) {
          return reply.code(403).send({ error: 'scenario_not_available' });
        }
        scenarioId = scenario.id;
      }
      const session = await repo.createSession(learner.id, body.data.mode, scenarioId);
      await repo.touchStreak(learner.id);
      return reply.code(201).send({
        id: session.id,
        mode: session.mode,
        scenario_id: session.scenarioId,
        started_at: session.startedAt,
        stream_url: `/v1/sessions/${session.id}/stream`,
      });
    });

    r.get<{ Querystring: { level?: string } }>('/v1/scenarios', async (req) => {
      const learner = await repo.getLearnerBySubject(req.subject);
      const level = Cefr.safeParse(req.query.level);
      const audience = learner ? (learner.ageBand === 'kid' ? 'kids' : learner.ageBand === 'adult' ? 'adults' : undefined) : undefined;
      const scenarios = await repo.listScenarios({ level: level.success ? level.data : undefined, audience });
      return scenarios.map((s) => ({ id: s.id, title: s.title, level: s.level, role: s.role, goal: s.goal, target_vocab: s.targetVocab }));
    });

    r.get<{ Params: { id: string } }>('/v1/sessions/:id/summary', async (req, reply) => {
      const session = await repo.getSession(req.params.id);
      const learner = session ? await ownLearner(req, reply, session.learnerId) : null;
      if (!session) return reply.code(404).send({ error: 'not_found' });
      if (!learner) return;
      if (session.summary) return { session_id: session.id, ended_at: session.endedAt, summary: session.summary };
      const summary = await summariseSession(deps.llm, {
        ageBand: learner.ageBand,
        cefr: learner.cefrLevel,
        mode: session.mode,
        turns: await repo.listTurns(session.id),
      });
      // Summaries requested mid-session are not persisted; ending the session stores the final one.
      if (session.endedAt) await repo.endSession(session.id, summary);
      return { session_id: session.id, ended_at: session.endedAt, summary };
    });

    r.post('/v1/tts/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = TtsPreviewBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      const verdict = await deps.safety.checkInput(body.data.text, 'kid');
      if (!verdict.allowed) return reply.code(422).send({ error: 'content_blocked' });
      const audio = await deps.ttsCache.get({ text: body.data.text, role: body.data.voice, rate: body.data.rate });
      return reply.header('content-type', deps.ttsMime).header('cache-control', 'private, max-age=86400').send(audio);
    });

    r.delete<{ Params: { id: string } }>('/v1/learners/:id/data', async (req, reply) => {
      const learner = await ownLearner(req, reply, req.params.id);
      if (!learner) return;
      const { audioUrls, requestId } = await repo.deleteLearnerData(learner.id);
      // Blob deletion runs after the DB commit; the prefix sweep catches anything not referenced by a turn.
      let deleted = 0;
      for (const url of audioUrls) {
        await deps.audioStore.delete(url).then(() => deleted++, (err) => deps.log.error({ err }, 'blob delete failed'));
      }
      deleted += await deps.audioStore.deleteLearner(learner.id).catch(() => 0);
      await repo.completeDeletion(requestId, deleted);
      return reply.code(202).send({ request_id: requestId, status: 'completed' });
    });
  });
}

function publicLearner(l: Learner) {
  return {
    id: l.id,
    display_name: l.displayName,
    age_band: l.ageBand,
    l1: l.l1,
    level: l.cefrLevel,
    preferred_voice: l.preferredVoice,
    consent: { parental: l.consent.parental, audio_storage: l.consent.audioStorage },
    created_at: l.createdAt,
  };
}
