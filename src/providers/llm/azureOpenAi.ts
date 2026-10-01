import OpenAI from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import type { Env } from '../../config/env.js';
import type { LlmProvider, StreamJsonRequest, StreamResult } from './types.js';

/**
 * Azure OpenAI via the GA v1 API (`<endpoint>/openai/v1/`) using the standard `openai` client:
 * no api-version juggling, and the same code works against other OpenAI-compatible Foundry models.
 */
export class AzureOpenAiLlm implements LlmProvider {
  private readonly client: OpenAI;

  constructor(private readonly env: Env) {
    const baseURL = `${env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/v1/`;
    const apiKey = env.AZURE_OPENAI_API_KEY
      ? env.AZURE_OPENAI_API_KEY
      : getBearerTokenProvider(new DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default');
    this.client = new OpenAI({ baseURL, apiKey, maxRetries: 1, timeout: 15_000 });
  }

  private deployment(tier: StreamJsonRequest['tier']): string {
    if (tier === 'summary') return this.env.AZURE_OPENAI_SUMMARY_DEPLOYMENT;
    if (tier === 'kids') return this.env.AZURE_OPENAI_KIDS_DEPLOYMENT ?? this.env.AZURE_OPENAI_TUTOR_DEPLOYMENT;
    return this.env.AZURE_OPENAI_TUTOR_DEPLOYMENT;
  }

  async streamJson(req: StreamJsonRequest, onDelta: (delta: string) => void): Promise<StreamResult> {
    const responseFormat =
      this.env.AZURE_OPENAI_RESPONSE_FORMAT === 'json_schema'
        ? { type: 'json_schema' as const, json_schema: req.schema }
        : { type: 'json_object' as const };
    const effort = this.env.AZURE_OPENAI_REASONING_EFFORT;

    let text = '';
    let finishReason: string | null = null;
    let usage: StreamResult['usage'] = null;
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.deployment(req.tier),
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
          response_format: responseFormat,
          max_completion_tokens: req.maxOutputTokens,
          ...(effort ? { reasoning_effort: effort as never } : { temperature: req.tier === 'summary' ? 0.3 : 0.6 }),
        },
        { signal: req.signal },
      );
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    } catch (err) {
      // Azure content filter on the prompt surfaces as HTTP 400 with code content_filter.
      if (err instanceof OpenAI.APIError && (err.code === 'content_filter' || /content management policy/i.test(err.message))) {
        return { text, usage, filtered: true, finishReason: 'content_filter' };
      }
      throw err;
    }
    return { text, usage, filtered: finishReason === 'content_filter', finishReason };
  }
}
