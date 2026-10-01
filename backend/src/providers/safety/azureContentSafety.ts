import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { SafetyProfile, SafetyProvider, SafetyVerdict } from './types.js';

const API_VERSION = '2024-09-01';

/**
 * Max allowed severity per category (FourSeverityLevels: 0 safe, 2 low, 4 medium, 6 high).
 * Kids: block anything above "safe" except low-level violence (cricket "attack", mythology stories).
 */
const THRESHOLDS: Record<SafetyProfile, Record<string, number>> = {
  kid: { Hate: 0, SelfHarm: 0, Sexual: 0, Violence: 2 },
  standard: { Hate: 2, SelfHarm: 2, Sexual: 2, Violence: 4 },
};

type Category = 'Hate' | 'SelfHarm' | 'Sexual' | 'Violence';

/**
 * Azure AI Content Safety on learner input (text:analyze + Prompt Shields) and model output
 * (text:analyze). This runs in addition to the Azure OpenAI deployment's own content filter
 * (PRD §12), because the transcript also drives UI text and stored data.
 */
export class AzureContentSafety implements SafetyProvider {
  private readonly token?: () => Promise<string>;

  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {
    if (!env.AZURE_CONTENT_SAFETY_KEY) {
      this.token = getBearerTokenProvider(new DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default');
    }
  }

  async checkInput(text: string, profile: SafetyProfile): Promise<SafetyVerdict> {
    const [harm, shield] = await Promise.all([this.analyze(text, profile), this.shield(text)]);
    if (!harm.allowed) return harm;
    if (shield) return { allowed: false, category: 'PromptAttack', severity: 6, escalate: false };
    return harm;
  }

  checkOutput(text: string, profile: SafetyProfile): Promise<SafetyVerdict> {
    return this.analyze(text, profile);
  }

  private async analyze(text: string, profile: SafetyProfile): Promise<SafetyVerdict> {
    const body = { text: text.slice(0, 10_000), categories: ['Hate', 'SelfHarm', 'Sexual', 'Violence'], outputType: 'FourSeverityLevels' };
    const res = await this.post<{ categoriesAnalysis: { category: Category; severity: number }[] }>('text:analyze', body);
    if (!res) return ALLOW; // fail-open on service error; the LLM deployment's own filter still applies
    const limits = THRESHOLDS[profile];
    let worst: { category: Category; severity: number } | null = null;
    for (const c of res.categoriesAnalysis) {
      if (c.severity > (limits[c.category] ?? 2) && (!worst || c.severity > worst.severity)) worst = c;
    }
    const selfHarm = res.categoriesAnalysis.find((c) => c.category === 'SelfHarm');
    if (!worst) return { ...ALLOW, escalate: (selfHarm?.severity ?? 0) >= 2 };
    return { allowed: false, category: worst.category, severity: worst.severity, escalate: worst.category === 'SelfHarm' };
  }

  private async shield(text: string): Promise<boolean> {
    const res = await this.post<{ userPromptAnalysis?: { attackDetected: boolean } }>('text:shieldPrompt', { userPrompt: text.slice(0, 10_000), documents: [] });
    return res?.userPromptAnalysis?.attackDetected ?? false;
  }

  private async post<T>(op: string, body: unknown): Promise<T | null> {
    const endpoint = this.env.AZURE_CONTENT_SAFETY_ENDPOINT!.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.env.AZURE_CONTENT_SAFETY_KEY) headers['Ocp-Apim-Subscription-Key'] = this.env.AZURE_CONTENT_SAFETY_KEY;
    else headers.authorization = `Bearer ${await this.token!()}`;
    try {
      const res = await fetch(`${endpoint}/contentsafety/${op}?api-version=${API_VERSION}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) {
        this.log.warn({ op, status: res.status }, 'content safety call failed');
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn({ op, err }, 'content safety call errored');
      return null;
    }
  }
}

const ALLOW: SafetyVerdict = { allowed: true, category: null, severity: 0, escalate: false };

/** Used when Content Safety isn't configured (local dev); relies on the Azure OpenAI filter only. */
export class NoopSafety implements SafetyProvider {
  async checkInput(): Promise<SafetyVerdict> {
    return ALLOW;
  }
  async checkOutput(): Promise<SafetyVerdict> {
    return ALLOW;
  }
}
