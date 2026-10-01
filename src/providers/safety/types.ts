export type SafetyProfile = 'kid' | 'standard';

export interface SafetyVerdict {
  allowed: boolean;
  /** Highest-severity category that triggered the block, if any. */
  category: 'Hate' | 'SelfHarm' | 'Sexual' | 'Violence' | 'PromptAttack' | null;
  severity: number;
  /** Self-harm content should trigger the escalation template rather than a plain refusal. */
  escalate: boolean;
}

export interface SafetyProvider {
  checkInput(text: string, profile: SafetyProfile): Promise<SafetyVerdict>;
  checkOutput(text: string, profile: SafetyProfile): Promise<SafetyVerdict>;
}
