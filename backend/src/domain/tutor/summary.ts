import { z } from 'zod';
import type { LlmProvider } from '../../providers/llm/types.js';
import type { AgeBand, Cefr, SessionMode, SessionSummary } from '../types.js';
import { buildSummaryPrompt } from './prompts.js';

const SUMMARY_SCHEMA = {
  name: 'session_summary',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['well_done', 'fix_next', 'new_phrases'],
    properties: {
      well_done: { type: 'array', items: { type: 'string' } },
      fix_next: { type: 'array', items: { type: 'string' } },
      new_phrases: { type: 'array', items: { type: 'string' } },
    },
  },
};

const SummarySchema = z.object({
  well_done: z.array(z.string()).max(5),
  fix_next: z.array(z.string()).max(5),
  new_phrases: z.array(z.string()).max(8),
});

export interface SummaryTurn {
  transcript: string;
  scores: { pronunciation?: number | null; fluency?: number | null } | null;
  llm: { reply?: string; correction?: { original: string; fixed: string } | null; pron_focus?: string | null } | null;
}

/** End-of-session feedback (PRD §7 GET /sessions/{id}/summary, §9 role-play 3-point summary). */
export async function summariseSession(
  llm: LlmProvider,
  args: { ageBand: AgeBand; cefr: Cefr; mode: SessionMode; turns: SummaryTurn[] },
): Promise<SessionSummary> {
  const avg = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const stats = {
    turns: args.turns.length,
    avgPronunciation: avg(args.turns.map((t) => t.scores?.pronunciation)),
    avgFluency: avg(args.turns.map((t) => t.scores?.fluency)),
  };
  if (args.turns.length === 0) return { wellDone: [], fixNext: [], newPhrases: [], stats };

  const transcript = args.turns
    .slice(-30)
    .map((t) => `Learner: ${t.transcript}\nNova: ${t.llm?.reply ?? ''}`)
    .join('\n');
  const corrections = args.turns.flatMap((t) => (t.llm?.correction ? [`"${t.llm.correction.original}" → "${t.llm.correction.fixed}"`] : []));
  const pronIssues = [...new Set(args.turns.flatMap((t) => (t.llm?.pron_focus ? [t.llm.pron_focus] : [])))];

  const prompt = buildSummaryPrompt({ ageBand: args.ageBand, cefr: args.cefr, mode: args.mode, transcript, corrections, pronIssues });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.streamJson(
      { messages: [{ role: 'user', content: `${prompt}\nRespond as JSON with keys well_done, fix_next, new_phrases.` }], schema: SUMMARY_SCHEMA, maxOutputTokens: 400, tier: 'summary' },
      () => {},
    );
    try {
      const parsed = SummarySchema.parse(JSON.parse(res.text));
      return { wellDone: parsed.well_done, fixNext: parsed.fix_next, newPhrases: parsed.new_phrases, stats };
    } catch {
      /* retry once */
    }
  }
  return {
    wellDone: ['You practised speaking English today - great effort!'],
    fixNext: corrections.slice(0, 2),
    newPhrases: [],
    stats,
  };
}
