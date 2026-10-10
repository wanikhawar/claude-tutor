// The UI's view of the backend.
import type { App } from "obsidian";
import type { Backend, ChatTurn } from "../../backend";
import type { Confidence, Gap, ImageInput, Mood, Question } from "../../core/types";

export type * from "../../core/types";
export type { ChatTurn, GradeOutcome, Mistake, NoteInfo, Snapshot } from "../../backend";

let backend: Backend;

export function setBackend(b: Backend) {
  backend = b;
}

export function obsidianApp(): App {
  return backend.app;
}

export const api = {
  snapshot: async () => backend.snapshot(),
  indexNote: (key: string, signal?: AbortSignal) => backend.indexNote(key, signal),
  openNote: (key: string, page?: number) => backend.openNote(key, page),
  openSettings: () => backend.openSettings(),
  folderSummary: () => backend.folderSummary(),
  rescan: () => backend.rescan(),
  inLibrary: (path: string) => backend.inLibrary(path),
  addFile: (path: string) => backend.addFile(path),
  addFolder: (path: string) => backend.addFolder(path),
  removeSource: (path: string) => backend.removeSource(path),
  skippedReason: (path: string) => backend.skippedReason(path),
  evaluateExplanation: (a: {
    conceptId: number;
    question: string;
    explanation: string;
    attempt: number;
    previousGaps: Gap[];
    peeked: boolean;
    stuck: boolean;
    images?: ImageInput[];
    signal?: AbortSignal;
    followUp?: string;
  }) => backend.evaluateExplanation(a),
  makeQuiz: (conceptIds: number[], count: number, signal?: AbortSignal) => backend.makeQuiz(conceptIds, count, signal),
  selfReport: async (conceptId: number, kind: "known" | "understood") => backend.selfReport(conceptId, kind),
  gradeAnswer: (
    question: Question,
    choice: number | null,
    answer: string,
    confidence: Confidence,
    images: ImageInput[] = [],
    signal?: AbortSignal,
  ) => backend.gradeAnswer(question, choice, answer, confidence, images, signal),
  checkAnswer: (a: {
    conceptId: number;
    question: string;
    key: string;
    misconception: string;
    answer: string;
    misconceptionId: number | null;
    images?: ImageInput[];
    signal?: AbortSignal;
  }) => backend.checkAnswer(a),
  chatHistory: (history: ChatTurn[]) => backend.chatHistory(history),
  askTutor: (
    conceptId: number | null,
    situation: string,
    history: ChatTurn[],
    message: string,
    images: ImageInput[] = [],
    signal?: AbortSignal,
  ) => backend.askTutor(conceptId, situation, history, message, images, signal),
  relevantNotes: async (topic: string) => backend.relevantNotes(topic),
  teach: (topic: string, sources: string[], history: [boolean, string][], message: string, images: ImageInput[] = [], signal?: AbortSignal) =>
    backend.teach(topic, sources, history, message, images, signal),
  saveLesson: (topic: string, summary: string, sources: string[]) => backend.saveLesson(topic, summary, sources),
  resolveMistake: async (id: number) => backend.resolveMistake(id),
  reopenMistake: async (id: number) => backend.reopenMistake(id),
};

/** True when a Claude request failed because the learner cancelled it. */
export function isCancel(e: unknown): boolean {
  return (e instanceof Error && e.name === "AbortError") || errText(e) === "Claude request cancelled.";
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

const MOODS: Mood[] = ["idle", "thinking", "happy", "celebrating", "encouraging", "concerned", "curious", "proud", "confused", "sleepy"];

export function asMood(s: string | undefined, fallback: Mood): Mood {
  const m = (s ?? "").trim().toLowerCase() as Mood;
  return MOODS.includes(m) ? m : fallback;
}
