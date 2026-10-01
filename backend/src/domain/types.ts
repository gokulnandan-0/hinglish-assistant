export type AgeBand = 'kid' | 'teen' | 'adult';
export type Cefr = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type SessionMode = 'tutor' | 'roleplay' | 'drill';
/** ISO 639-1 code of the learner's first language, e.g. hi, ta, te, bn, mr, kn, ml, gu. */
export type L1 = string;

export interface Learner {
  id: string;
  externalSubject: string;
  displayName: string | null;
  ageBand: AgeBand;
  l1: L1;
  cefrLevel: Cefr;
  consent: {
    parental: boolean;
    parentalVerifiedAt: string | null;
    audioStorage: boolean;
  };
  preferredVoice: 'conversation' | 'clear';
  createdAt: string;
}

export interface Scenario {
  id: string;
  title: string;
  level: Cefr;
  role: string;
  goal: string;
  targetVocab: string[];
  openingLine: string;
  safetyNotes: string;
  audience: 'all' | 'kids' | 'adults';
}

export interface Session {
  id: string;
  learnerId: string;
  mode: SessionMode;
  scenarioId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: SessionSummary | null;
}

export interface SessionSummary {
  wellDone: string[];
  fixNext: string[];
  newPhrases: string[];
  stats: { turns: number; avgPronunciation: number | null; avgFluency: number | null };
}

/** One phoneme as reported by assessment, normalised to IPA. */
export interface PhonemeResult {
  p: string;
  score: number;
  /** Most likely phoneme actually heard (from NBest), when available and different from `p`. */
  heard?: string;
}

export type WordErrorType =
  | 'None'
  | 'Mispronunciation'
  | 'Omission'
  | 'Insertion'
  | 'UnexpectedBreak'
  | 'MissingBreak'
  | 'Monotone';

export interface WordResult {
  w: string;
  score: number;
  error: WordErrorType;
  phonemes: PhonemeResult[];
  offsetMs?: number;
  durationMs?: number;
}

export interface UtteranceAssessment {
  text: string;
  words: WordResult[];
  scores: {
    accuracy: number | null;
    fluency: number | null;
    completeness: number | null;
    prosody: number | null;
    pronunciation: number | null;
  };
  /** Count of pauses longer than the long-pause threshold. */
  longPauses: number;
  durationMs: number;
  /** Locale actually used for scoring (en-IN, or en-US fallback for features en-IN lacks). */
  scoringLocale: string;
}

/** The single pronunciation issue chosen by the deterministic selector for this turn. */
export interface PronunciationFocus {
  word: string;
  score: number;
  expected: string | null;
  heard: string | null;
  rule: string;
  profileKey: string;
}

export interface TutorOutput {
  reply: string;
  correction: { original: string; fixed: string; why: string; key: string } | null;
  pron_tip: { word: string; tip: string } | null;
  next_prompt: string;
  /** Tracked error keys (from the prompt's recurring-errors list) the learner used correctly this turn. */
  practised_correctly: string[];
  /** Role-play only: the learner met the scenario goal. */
  scene_complete: boolean;
  /** Safety escalation requested by the model (self-harm, abuse). */
  safety_flag: 'none' | 'self_harm' | 'abuse' | 'other';
}

export type ErrorCategory = 'grammar' | 'phoneme' | 'vocab';

export interface ErrorProfileItem {
  category: ErrorCategory;
  key: string;
  count: number;
  lastSeen: string;
  mastery: number;
}
