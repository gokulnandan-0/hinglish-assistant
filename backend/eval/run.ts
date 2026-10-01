import { resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { evaluatePronunciation } from './pronunciation.js';

const [cmd = 'pron', arg] = process.argv.slice(2);
const fixtures = resolve(process.cwd(), 'eval/fixtures');

const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'pron':
    print(evaluatePronunciation(arg ?? resolve(fixtures, 'pronunciation.sample.jsonl')));
    break;
  case 'stt': {
    const { evaluateStt } = await import('./stt.js');
    if (!arg) throw new Error('usage: npm run eval -- stt <manifest.jsonl>');
    print(await evaluateStt(loadEnv(), arg));
    break;
  }
  case 'llm': {
    const { evaluateLlm } = await import('./llm.js');
    const r = await evaluateLlm(loadEnv(), arg ?? resolve(fixtures, 'tutor-cases.json'));
    print(r);
    if (r.passed < r.total) process.exitCode = 1;
    break;
  }
  case 'smoke': {
    const { smoke } = await import('./smoke.js');
    print(await smoke(loadEnv()));
    break;
  }
  default:
    console.error('usage: npm run eval -- <pron|stt|llm|smoke> [path]');
    process.exitCode = 2;
}
