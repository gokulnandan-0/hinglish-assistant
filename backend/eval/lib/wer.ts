/** Word error rate with light normalisation (case, punctuation, numbers as spoken are left to the reference). */
export function normaliseForWer(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function wordErrors(reference: string, hypothesis: string): { errors: number; words: number } {
  const r = normaliseForWer(reference);
  const h = normaliseForWer(hypothesis);
  const d: number[] = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (r[i - 1] === h[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return { errors: d[h.length]!, words: r.length };
}
