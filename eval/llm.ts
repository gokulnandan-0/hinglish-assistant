/**
 * Prompt regression suite (PRD §13: "automated regression run on every prompt or threshold change").
 * Runs fixed cases through the real tutor deployment and checks product rules deterministically.
 * Needs Azure OpenAI keys.
 */
import { readFileSync } from 'node:fs';
import type { Env } from '../src/config/env.js';
import { AzureOpenAiLlm } from '../src/providers/llm/azureOpenAi.js';
import { buildSystemPrompt, buildTurnInput, PROMPT_VERSION } from '../src/domain/tutor/prompts.js';
import { parseTutorOutput, TUTOR_JSON_SCHEMA } from '../src/domain/tutor/schema.js';
import type { AgeBand, Cefr, SessionMode } from '../src/domain/types.js';

interface Case {
  id: string;
  learner: { cefr: Cefr; l1: string; ageBand: AgeBand };
  mode: SessionMode;
  transcript: string;
  pronFocus: string | null;
  expect: { correction: 'required' | 'none' | 'any'; fixedContains?: string; mustNotCorrect?: string[]; pronWord?: string; maxReplyWords: number; replyMustNotMatch?: string };
}

export async function evaluateLlm(env: Env, path: string, repeats = 3) {
  const llm = new AzureOpenAiLlm(env);
  const cases = JSON.parse(readFileSync(path, 'utf8')) as Case[];
  const results = [];
  for (const c of cases) {
    const failures: string[] = [];
    const ttft: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const system = buildSystemPrompt({ ...c.learner, mode: c.mode, topErrors: 'none yet' });
      const user = buildTurnInput({
        assessment: { text: c.transcript, words: [], scores: { accuracy: 80, fluency: 75, completeness: 100, prosody: null, pronunciation: 78 }, longPauses: 0, durationMs: 3000, scoringLocale: 'en-IN' },
        pronFocus: c.pronFocus,
      });
      const started = Date.now();
      let first = 0;
      const res = await llm.streamJson(
        { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], schema: TUTOR_JSON_SCHEMA, maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS, tier: c.learner.ageBand === 'kid' ? 'kids' : 'tutor' },
        () => (first ||= Date.now()),
      );
      ttft.push(first - started);
      const out = parseTutorOutput(res.text, c.pronFocus?.split(' ')[0] ?? null);
      if (!out) {
        failures.push(`run${i}: invalid JSON`);
        continue;
      }
      const e = c.expect;
      if (e.correction === 'required' && !out.correction) failures.push(`run${i}: missing correction`);
      if (e.correction === 'none' && out.correction) failures.push(`run${i}: unexpected correction ${JSON.stringify(out.correction)}`);
      if (e.fixedContains && out.correction && !out.correction.fixed.toLowerCase().includes(e.fixedContains)) failures.push(`run${i}: fix lacks "${e.fixedContains}"`);
      for (const w of e.mustNotCorrect ?? []) if (out.correction?.original.toLowerCase().includes(w)) failures.push(`run${i}: corrected valid usage "${w}"`);
      if (e.pronWord && out.pron_tip?.word.toLowerCase() !== e.pronWord) failures.push(`run${i}: pron tip missing for ${e.pronWord}`);
      if (!e.pronWord && out.pron_tip) failures.push(`run${i}: unexpected pron tip`);
      const words = out.reply.split(/\s+/).length;
      if (words > e.maxReplyWords) failures.push(`run${i}: reply too long (${words} words)`);
      if (e.replyMustNotMatch && new RegExp(e.replyMustNotMatch).test(out.reply)) failures.push(`run${i}: reply matched forbidden pattern`);
    }
    ttft.sort((a, b) => a - b);
    results.push({ id: c.id, pass: failures.length === 0, failures, ttft_p50_ms: ttft[Math.floor(ttft.length / 2)] });
  }
  return { prompt_version: PROMPT_VERSION, passed: results.filter((r) => r.pass).length, total: results.length, results };
}
