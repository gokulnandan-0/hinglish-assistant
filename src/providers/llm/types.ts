export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

export interface StreamJsonRequest {
  messages: ChatMessage[];
  schema: JsonSchemaSpec;
  maxOutputTokens: number;
  /** Which deployment tier to use. */
  tier: 'tutor' | 'kids' | 'summary';
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface StreamResult {
  text: string;
  usage: LlmUsage | null;
  /** Provider-side content filter blocked the prompt or completion. */
  filtered: boolean;
  finishReason: string | null;
}

export interface LlmProvider {
  /** Streams raw JSON text deltas to `onDelta` and resolves with the full text. */
  streamJson(req: StreamJsonRequest, onDelta: (delta: string) => void): Promise<StreamResult>;
}
