/**
 * Incremental scanner for a single top-level JSON object streamed token by token.
 *
 * Why: the PRD asks for both (a) a strict JSON reply and (b) TTS that starts on the first sentence
 * while the LLM is still generating. A naive "wait for the full JSON, then parse" costs the whole
 * generation time before any audio. With structured outputs the model emits keys in schema order,
 * so we can surface each top-level member as soon as it closes and stream the `reply` string's
 * characters live.
 */
export interface JsonStreamHandlers {
  /** Called when a top-level member's value is complete. `raw` is the JSON text of the value. */
  onMember?: (key: string, raw: string) => void;
  /** Called with decoded characters of top-level string members listed in `streamKeys`. */
  onStringDelta?: (key: string, text: string) => void;
}

type State = 'start' | 'key' | 'colon' | 'value' | 'after';

export class TopLevelJsonStream {
  private state: State = 'start';
  private keyBuf = '';
  private currentKey = '';
  private valueBuf = '';
  private depth = 0;
  private inString = false;
  private escape = false;
  private unicode: string | null = null;
  private valueIsString = false;
  private done = false;

  constructor(
    private readonly handlers: JsonStreamHandlers,
    private readonly streamKeys: ReadonlySet<string> = new Set(['reply']),
  ) {}

  get finished(): boolean {
    return this.done;
  }

  write(chunk: string): void {
    for (const ch of chunk) this.step(ch);
  }

  private step(ch: string): void {
    if (this.done) return;
    switch (this.state) {
      case 'start':
        if (ch === '{') this.state = 'after';
        return;
      case 'after':
        if (ch === '"') {
          this.state = 'key';
          this.keyBuf = '';
          this.escape = false;
        } else if (ch === '}') {
          this.done = true;
        }
        return;
      case 'key':
        if (this.escape) {
          this.keyBuf += ch;
          this.escape = false;
        } else if (ch === '\\') this.escape = true;
        else if (ch === '"') {
          this.currentKey = this.keyBuf;
          this.state = 'colon';
        } else this.keyBuf += ch;
        return;
      case 'colon':
        if (ch === ':') {
          this.state = 'value';
          this.valueBuf = '';
          this.depth = 0;
          this.inString = false;
          this.escape = false;
          this.valueIsString = false;
        }
        return;
      case 'value':
        this.stepValue(ch);
        return;
    }
  }

  private stepValue(ch: string): void {
    // Skip whitespace before the value starts.
    if (this.valueBuf === '' && /\s/.test(ch)) return;
    if (this.valueBuf === '' && ch === '"') this.valueIsString = true;

    const atTop = this.depth === 0;
    if (!this.inString && atTop && this.valueBuf !== '' && !this.valueIsString && (ch === ',' || ch === '}')) {
      // End of a primitive value (number, true/false/null) or of a completed object/array.
      this.emitMember();
      this.state = 'after';
      if (ch === '}') this.done = true;
      return;
    }

    this.valueBuf += ch;
    const streaming = this.valueIsString && this.streamKeys.has(this.currentKey);

    if (this.inString) {
      if (this.unicode !== null) {
        this.unicode += ch;
        if (this.unicode.length === 4) {
          if (streaming && this.depth === 0) this.handlers.onStringDelta?.(this.currentKey, String.fromCharCode(parseInt(this.unicode, 16)));
          this.unicode = null;
        }
        return;
      }
      if (this.escape) {
        this.escape = false;
        if (ch === 'u') {
          this.unicode = '';
          return;
        }
        if (streaming && this.depth === 0) this.handlers.onStringDelta?.(this.currentKey, ESCAPES[ch] ?? ch);
        return;
      }
      if (ch === '\\') {
        this.escape = true;
        return;
      }
      if (ch === '"') {
        this.inString = false;
        if (this.valueIsString && this.depth === 0) {
          this.emitMember();
          this.state = 'after';
        }
        return;
      }
      if (streaming && this.depth === 0) this.handlers.onStringDelta?.(this.currentKey, ch);
      return;
    }

    if (ch === '"') {
      this.inString = true;
      return;
    }
    if (ch === '{' || ch === '[') this.depth++;
    else if (ch === '}' || ch === ']') {
      this.depth--;
      if (this.depth === 0) {
        this.emitMember();
        this.state = 'after';
      }
    }
  }

  // After a string/object value closes, the following ',' is ignored by the 'after' state.
  private emitMember(): void {
    this.handlers.onMember?.(this.currentKey, this.valueBuf.trim());
    this.valueBuf = '';
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
