const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'rs']);

/**
 * Splits streamed text into speakable chunks so TTS can start on the first sentence while the LLM
 * is still generating (PRD §5 step 6). The first chunk may be flushed early at a clause boundary to
 * protect time-to-first-audio.
 */
export class SentenceSplitter {
  private buf = '';
  private emitted = 0;

  constructor(
    private readonly onSentence: (sentence: string) => void,
    private readonly opts = { firstChunkMinChars: 24, clauseFlushChars: 70 },
  ) {}

  push(text: string): void {
    this.buf += text;
    this.drain();
  }

  flush(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.emit(rest);
  }

  private drain(): void {
    for (;;) {
      const cut = this.findBoundary();
      if (cut < 0) return;
      const sentence = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (sentence) this.emit(sentence);
    }
  }

  private findBoundary(): number {
    const b = this.buf;
    for (let i = 0; i < b.length - 1; i++) {
      const ch = b[i]!;
      const next = b[i + 1]!;
      if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(next)) {
        if (ch === '.' && this.isAbbreviation(b.slice(0, i))) continue;
        if (this.emitted === 0 && i + 1 < this.opts.firstChunkMinChars && ch === '.') continue;
        return i + 1;
      }
      if (ch === '\n') return i + 1;
    }
    // Long clause without a full stop: cut at a comma/semicolon so audio keeps flowing.
    if (b.length >= this.opts.clauseFlushChars) {
      const idx = Math.max(b.lastIndexOf(', '), b.lastIndexOf('; '), b.lastIndexOf(': '));
      if (idx > 20) return idx + 1;
    }
    return -1;
  }

  private isAbbreviation(before: string): boolean {
    const word = before.split(/\s/).pop()?.toLowerCase().replace(/[^a-z.]/g, '') ?? '';
    return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word);
  }

  private emit(s: string): void {
    this.emitted++;
    this.onSentence(s);
  }
}
