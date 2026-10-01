/**
 * WER by L1 group on the accent test set (PRD §13, target ≤ 15%), through the SAME recogniser code
 * the product uses. Needs Azure Speech keys.
 *
 * Manifest (JSONL): {"id","l1","gender","age_band","audio":"path/to/16k-mono.wav","reference":"human-verified transcript"}
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino from 'pino';
import type { Env } from '../src/config/env.js';
import { AzureSpeechRecognizer } from '../src/providers/speech/azureRecognizer.js';
import { loadPronunciationPolicy } from '../src/domain/pronunciation/policy.js';
import { wordErrors } from './lib/wer.js';

export async function evaluateStt(env: Env, manifestPath: string) {
  const policy = loadPronunciationPolicy();
  const rec = new AzureSpeechRecognizer(env, pino({ level: 'warn' }), policy.thresholds.enUsPhonemeCalibration);
  const rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const groups = new Map<string, { errors: number; words: number; n: number; detailMissing: number; ms: number[] }>();
  for (const row of rows) {
    const wav = readFileSync(resolve(dirname(manifestPath), row.audio));
    const pcm = wav.subarray(44); // assumes canonical 44-byte WAV header, 16 kHz mono 16-bit
    const started = Date.now();
    const stream = await rec.start({ segmentationSilenceMs: 800, phrases: policy.neutralWords.words, prosody: false }, { onPartial() {}, onSegment() {}, onError(e) { console.warn(row.id, e.message); } });
    for (let i = 0; i < pcm.length; i += 3200) stream.write(pcm.subarray(i, i + 3200));
    const result = await stream.finish();
    const { errors, words } = wordErrors(row.reference, result.text);
    const key = `${row.l1}/${row.age_band ?? 'all'}`;
    const g = groups.get(key) ?? { errors: 0, words: 0, n: 0, detailMissing: 0, ms: [] };
    g.errors += errors;
    g.words += words;
    g.n++;
    if (!result.scoringLocale.includes('+')) g.detailMissing++;
    g.ms.push(Date.now() - started);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([group, g]) => ({
    group,
    utterances: g.n,
    wer: +(g.errors / Math.max(1, g.words)).toFixed(3),
    meets_target: g.errors / Math.max(1, g.words) <= 0.15,
    detail_lane_missing_rate: +(g.detailMissing / g.n).toFixed(3),
  }));
}
