// Shared data types for the core, backend and UI.

export type Mood =
  | "idle"
  | "thinking"
  | "happy"
  | "celebrating"
  | "encouraging"
  | "concerned"
  | "curious"
  | "proud"
  | "confused"
  | "sleepy";

export interface Concept {
  id: number;
  note_path: string;
  name: string;
  summary: string;
  prerequisites: string[];
  excerpt: string;
  /** Focused Feynman questions about the core of the idea, asked in rotation. */
  questions: string[];
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due: string | null;
  mastery: number;
  last_reviewed: string | null;
}

export type NoteKind = "markdown" | "pdf";

/** A note the tutor can teach from: a Markdown file or one page-range part of a PDF. */
export interface Note {
  /** Vault path, plus `#p<first>-<last>` for parts of a split PDF. Database key. */
  key: string;
  /** Vault path of the file. */
  path: string;
  title: string;
  body: string;
  hash: string;
  links: string[];
  kind: NoteKind;
  /** Vault path of the PDF, set on every part of a split PDF. */
  group: string | null;
  pages: [number, number] | null;
}

export interface Skipped {
  rel: string;
  reason: string;
}

export interface ExtractedConcept {
  name: string;
  summary: string;
  prerequisites: string[];
  excerpt: string;
  questions: string[];
}

export interface Gap {
  kind: "missing" | "wrong" | "jargon" | "vague";
  issue: string;
  fix: string;
}

export interface FeynmanEval {
  score: number;
  passed: boolean;
  got_right: string[];
  gaps: Gap[];
  reteach: string;
  analogy: string;
  next_prompt: string;
  note_issues: string[];
  prerequisite_gap: string;
  mood: string;
  mascot_line: string;
}

export interface Question {
  /** Stable identity from the selected quiz materials; names need not be unique. */
  concept_id: number;
  /** Existing mistake this question targets, or null for general practice. */
  misconception_id: number | null;
  concept: string;
  kind: "mcq" | "short" | "explain_why" | "spot_error";
  question: string;
  options: string[];
  correct_option: number;
  answer: string;
  explanation: string;
}

export interface QuizSet {
  questions: Question[];
  mood: string;
  mascot_line: string;
}

export interface Grade {
  correct: boolean;
  score: number;
  feedback: string;
  misconception: string;
  /** Existing misconception diagnosed in this answer; null for a new belief or a slip. */
  misconception_id: number | null;
  prerequisite_gap: string;
  lesson: string;
  analogy: string;
  check_question: string;
  check_answer: string;
  mood: string;
  mascot_line: string;
}

export interface CheckResult {
  understood: boolean;
  feedback: string;
  mood: string;
  mascot_line: string;
}

export interface ChatReply {
  reply: string;
  mood: string;
  mascot_line: string;
}

export type Confidence = "guess" | "unsure" | "sure";

/** An image the learner attached (base64 without the data: prefix). */
export interface ImageInput {
  mediaType: string;
  data: string;
  name?: string;
}

export interface TeachReply {
  reply: string;
  /** Where the lesson is: intro → teaching → checking → wrap_up. */
  stage: "intro" | "teaching" | "checking" | "wrap_up";
  /** 0-100, how far through the lesson plan. */
  progress: number;
  step_title: string;
  /** Markdown summary of what was learned; only filled at wrap_up. */
  summary: string;
  mood: string;
  mascot_line: string;
}

export function isMcq(q: Question) {
  return q.kind === "mcq" && q.options.length > 0;
}
