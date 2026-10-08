// The UI's view of the backend.
import type { App } from "obsidian";
import type { Backend } from "../../backend";
import type { Confidence, Gap, ImageInput, Mood, Question } from "../../core/types";

export type * from "../../core/types";
export type { GradeOutcome, Mistake, NoteInfo, Snapshot } from "../../backend";

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
  }) => backend.evaluateExplanation(a),
  makeQuiz: (conceptIds: number[], count: number) => backend.makeQuiz(conceptIds, count),
  selfReport: async (conceptId: number, kind: "known" | "understood") => backend.selfReport(conceptId, kind),
  gradeAnswer: (question: Question, choice: number | null, answer: string, confidence: Confidence, images: ImageInput[] = []) =>
    backend.gradeAnswer(question, choice, answer, confidence, images),
  checkAnswer: (a: {
    question: string;
    key: string;
    misconception: string;
    answer: string;
    misconceptionId: number | null;
    images?: ImageInput[];
  }) => backend.checkAnswer(a),
  askTutor: (conceptId: number | null, situation: string, history: [boolean, string][], message: string, images: ImageInput[] = []) =>
    backend.askTutor(conceptId, situation, history, message, images),
  relevantNotes: async (topic: string) => backend.relevantNotes(topic),
  teach: (topic: string, sources: string[], history: [boolean, string][], message: string, images: ImageInput[] = []) =>
    backend.teach(topic, sources, history, message, images),
  saveLesson: (topic: string, summary: string, sources: string[]) => backend.saveLesson(topic, summary, sources),
  resolveMistake: async (id: number) => backend.resolveMistake(id),
};

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

const MOODS: Mood[] = ["idle", "thinking", "happy", "celebrating", "encouraging", "concerned", "curious", "proud", "confused", "sleepy"];

export function asMood(s: string | undefined, fallback: Mood): Mood {
  const m = (s ?? "").trim().toLowerCase() as Mood;
  return MOODS.includes(m) ? m : fallback;
}
