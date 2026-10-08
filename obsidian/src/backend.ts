// What the UI calls, backed by the vault library and a JSON progress file.

import { TFile, normalizePath, type App } from "obsidian";
import type { ClaudeOptions } from "./core/claude";
import { clip } from "./core/notes";
import { Progress } from "./core/progress";
import { review } from "./core/srs";
import * as tutor from "./core/tutor";
import {
  isMcq,
  type ChatReply,
  type CheckResult,
  type Concept,
  type Confidence,
  type FeynmanEval,
  type Gap,
  type Grade,
  type ImageInput,
  type NoteKind,
  type TeachReply,
  type Question,
  type QuizSet,
  type Skipped,
} from "./core/types";
import type { Library } from "./library";
import { MODEL_CHOICES, resolvedName, type TutorSettings } from "./settings";

const STOPWORDS = new Set(
  "the and for with how why what when does work works about into from that this are was were you your teach explain learn understand want know".split(" "),
);

/** Max characters of note text sent with a single request. */
const NOTE_BUDGET = 30_000;

export interface NoteInfo {
  key: string;
  rel: string;
  title: string;
  stale: boolean;
  /** Clawd has read some version of this note before. */
  indexed: boolean;
  kind: NoteKind;
  group: string | null;
  pages: [number, number] | null;
}

export interface Mistake {
  id: number;
  concept_id: number | null;
  concept_name: string | null;
  text: string;
}

export interface Snapshot {
  vault: string;
  configured: boolean;
  /** What the library is made of: study folders and individually added files. */
  sources: { folders: string[]; files: string[] };
  notes: NoteInfo[];
  skipped: Skipped[];
  concepts: Concept[];
  mistakes: Mistake[];
  reviews_today: number;
  model: string;
  effort: string;
  /** Display names of the exact models, by alias (e.g. sonnet → "Sonnet 5.5"). */
  modelNames: Record<string, string>;
  autoIndex: boolean;
  confirmAbove: number;
}

export interface GradeOutcome {
  grade: Grade;
  misconception_id: number | null;
}

export class Backend {
  private listeners = new Set<() => void>();
  private requests = new AbortController();

  constructor(
    public app: App,
    public library: Library,
    public progress: Progress,
    private settings: () => TutorSettings,
    private claudeCwd: string,
    private openSettingsTab: () => void,
    private saveSettings: () => Promise<void>,
  ) {}

  dispose() {
    this.requests.abort();
    this.listeners.clear();
    this.library.dispose();
  }

  // -------------------------------------------------------------------------
  // Change notifications (vault edits, rescans)

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  async rescan() {
    await this.library.loadAll();
    this.emit();
  }

  private claude(signal?: AbortSignal): ClaudeOptions {
    const s = this.settings();
    const alias = s.model;
    return {
      path: s.claudePath,
      model: alias,
      effort: s.effort,
      cwd: this.claudeCwd,
      signal: signal ? AbortSignal.any([this.requests.signal, signal]) : this.requests.signal,
      // Remember which exact model the alias resolved to, so the picker can show it.
      onModel: (id) => {
        if (s.resolvedModels[alias] === id) return;
        s.resolvedModels[alias] = id;
        void this.saveSettings();
      },
    };
  }

  private note(key: string) {
    const n = this.library.notes.get(key);
    if (!n) throw new Error("That note is no longer in the library.");
    return n;
  }

  private noteText(key: string, budget: number): [string, string] {
    const n = this.library.notes.get(key);
    return n ? [n.title, clip(n.body, budget)] : ["", ""];
  }

  private concepts(): Concept[] {
    return this.progress.conceptsFor(new Set(this.library.notes.keys()));
  }

  private concept(id: number): Concept {
    const c = this.progress.concept(id);
    if (!c) throw new Error("That concept no longer exists.");
    return c;
  }

  private storeReview(c: Concept, score: number) {
    review(c, score);
    this.progress.touch();
  }

  // -------------------------------------------------------------------------
  // Commands

  snapshot(): Snapshot {
    const s = this.settings();
    const concepts = this.concepts().map((c) => ({ ...c }));
    const ids = new Set(concepts.map((c) => c.id));
    return {
      vault: this.app.vault.getName(),
      configured: s.studyFolders.length > 0 || s.studyFiles.length > 0,
      sources: { folders: [...s.studyFolders], files: [...s.studyFiles] },
      notes: this.library.sorted().map((n) => ({
        key: n.key,
        rel: n.path,
        title: n.title,
        stale: !this.progress.isCurrent(n.key, n.hash),
        indexed: this.progress.noteHash(n.key) !== undefined,
        kind: n.kind,
        group: n.group,
        pages: n.pages,
      })),
      skipped: [...this.library.skipped.values()],
      concepts,
      mistakes: this.progress
        .openMisconceptions()
        .filter((m) => m.concept_id !== null && ids.has(m.concept_id))
        .map((m) => ({
          id: m.id,
          concept_id: m.concept_id,
          concept_name: concepts.find((c) => c.id === m.concept_id)?.name ?? null,
          text: m.text,
        })),
      reviews_today: this.progress.attemptsToday(),
      model: s.model,
      effort: s.effort,
      modelNames: Object.fromEntries(MODEL_CHOICES.map((m) => [m.id, resolvedName(s, m.id)])),
      autoIndex: s.autoIndex,
      confirmAbove: s.confirmAbove,
    };
  }

  /** Have Claude read one note and extract its concepts. */
  async indexNote(key: string, signal?: AbortSignal): Promise<Snapshot> {
    const options = this.claude(signal);
    await this.library.waitForFile(key);
    if (options.signal?.aborted) throw new Error("Claude request cancelled.");
    const note = this.note(key);
    if (this.progress.isCurrent(key, note.hash)) return this.snapshot();
    const known = this.concepts()
      .map((c) => c.name)
      .slice(0, 200);
    const list = await tutor.extractConcepts(options, note.title, clip(note.body, NOTE_BUDGET), known);
    await this.library.waitForFile(key);
    if (options.signal?.aborted) throw new Error("Claude request cancelled.");
    // The note may have changed while Claude was reading; only store if it's the same version.
    if (this.library.notes.get(key)?.hash === note.hash) this.progress.saveConcepts(key, note.hash, list.concepts);
    return this.snapshot();
  }

  /** Open a note (or a PDF at the right page) in Obsidian, next to the tutor. */
  async openNote(key: string, page?: number) {
    const n = this.note(key);
    const file = this.app.vault.getAbstractFileByPath(n.path);
    if (!(file instanceof TFile)) return;
    const p = page ?? n.pages?.[0];
    const link = n.kind === "pdf" && p && p > 1 ? `${n.path}#page=${p}` : n.path;
    await this.app.workspace.openLinkText(link, "", "tab");
  }

  openSettings() {
    this.openSettingsTab();
  }

  // -------------------------------------------------------------------------
  // Library sources

  inLibrary(path: string): boolean {
    return this.library.inScope(path);
  }

  /** Add one note or PDF on its own. Returns the keys it produced (empty if unreadable). */
  async addFile(path: string): Promise<string[]> {
    const s = this.settings();
    if (!s.studyFiles.includes(path)) s.studyFiles.push(path);
    await this.saveSettings();
    const file = this.app.vault.getAbstractFileByPath(path);
    const keys = file instanceof TFile ? await this.library.loadFile(file) : [];
    this.emit();
    return keys;
  }

  async addFolder(path: string) {
    const s = this.settings();
    if (!s.studyFolders.includes(path)) s.studyFolders.push(path);
    await this.saveSettings();
    await this.rescan();
  }

  async removeSource(path: string) {
    const s = this.settings();
    s.studyFolders = s.studyFolders.filter((f) => f !== path);
    s.studyFiles = s.studyFiles.filter((f) => f !== path);
    await this.saveSettings();
    await this.rescan();
  }

  skippedReason(path: string): string | undefined {
    return this.library.skipped.get(path)?.reason;
  }

  /** Folders with how many notes/PDFs they contain (for first-run setup). */
  folderSummary(): { path: string; count: number }[] {
    const files = this.app.vault.getFiles().filter((f) => {
      const ext = f.extension.toLowerCase();
      return (ext === "md" || (ext === "pdf" && this.settings().includePdfs)) && !f.path.startsWith(this.app.vault.configDir + "/");
    });
    const counts = new Map<string, number>([["/", files.length]]);
    for (const f of files) {
      const parts = f.path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }
    return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Feynman step: evaluate the learner's explanation and update progress. */
  async evaluateExplanation(a: {
    conceptId: number;
    question: string;
    explanation: string;
    attempt: number;
    previousGaps: Gap[];
    peeked: boolean;
    stuck: boolean;
    images?: ImageInput[];
  }): Promise<FeynmanEval> {
    const concept = this.concept(a.conceptId);
    const [noteTitle, noteBody] = this.noteText(concept.note_path, NOTE_BUDGET);
    const ev = await tutor.evaluateFeynman(this.claude(), {
      concept,
      question: a.question,
      noteTitle,
      noteBody,
      attempt: a.attempt,
      explanation: a.stuck ? "" : a.explanation,
      previousGaps: a.previousGaps,
      peeked: a.peeked,
      stuck: a.stuck,
      images: a.images,
    });
    const score = Math.min(1, Math.max(0, ev.score / 100));
    this.progress.logAttempt(a.conceptId, "feynman", score);
    for (const g of ev.gaps.filter((g) => g.kind === "wrong")) this.progress.addMisconception(a.conceptId, g.issue);
    // Spaced repetition tracks first-try recall; peeking costs a little.
    if (a.attempt === 0) this.storeReview(concept, a.peeked ? score * 0.85 : score);
    return ev;
  }

  /**
   * The learner says they understand a concept (no Claude check).
   * "known" = before trying: reviewed as fairly solid, so it comes back in a day or so.
   * "understood" = after feedback: their first-try score already set the schedule; just log it.
   */
  selfReport(conceptId: number, kind: "known" | "understood") {
    const c = this.concept(conceptId);
    this.progress.logAttempt(conceptId, `self-${kind}`, kind === "known" ? 0.7 : 0.6);
    if (kind === "known") this.storeReview(c, 0.7);
  }

  async makeQuiz(conceptIds: number[], count: number): Promise<QuizSet> {
    const pool = conceptIds
      .map((id) => this.progress.concept(id))
      .filter((c): c is Concept => !!c)
      .slice(0, 8);
    if (!pool.length) throw new Error("No concepts to quiz on yet.");
    const perNote = Math.min(12_000, Math.max(4_000, Math.floor(NOTE_BUDGET / pool.length)));
    const seen = new Set<string>();
    const materials = pool.map((c) => {
      const [noteTitle, body] = this.noteText(c.note_path, perNote);
      const first = !seen.has(c.note_path);
      seen.add(c.note_path);
      return { concept: c, noteTitle, noteBody: first ? body : "(same note as above)" };
    });
    const ids = new Set(pool.map((c) => c.id));
    const misc = this.progress
      .openMisconceptions()
      .filter((m) => m.concept_id !== null && ids.has(m.concept_id))
      .slice(0, 10);
    const quiz = await tutor.makeQuiz(this.claude(), materials, misc, Math.min(12, Math.max(1, count)));
    for (const q of quiz.questions) {
      const concept = pool.find((c) => c.id === q.concept_id);
      if (!concept) throw new Error("Claude returned a question for a concept outside this quiz.");
      q.concept = concept.name;
      if (q.misconception_id !== null && !misc.some((m) => m.id === q.misconception_id && m.concept_id === concept.id)) {
        throw new Error("Claude returned a question for an unrelated misconception.");
      }
    }
    return quiz;
  }

  async gradeAnswer(
    question: Question,
    choice: number | null,
    answer: string,
    confidence: Confidence,
    images: ImageInput[] = [],
  ): Promise<GradeOutcome> {
    const concept = this.concept(question.concept_id);
    const target = this.progress.openMisconceptions().find((m) => m.id === question.misconception_id && m.concept_id === concept.id);
    let grade: Grade;
    if (choice !== null && isMcq(question) && choice === question.correct_option) {
      // Correct multiple choice needs no round-trip to Claude.
      const lines = ["Nailed it!", "Correct! Neurons firing nicely.", "Yep! Clean answer.", "That's the one!"];
      grade = {
        correct: true,
        score: 100,
        feedback: question.explanation,
        misconception: "",
        misconception_id: null,
        prerequisite_gap: "",
        lesson: "",
        analogy: "",
        check_question: "",
        check_answer: "",
        mood: confidence === "sure" ? "proud" : "happy",
        mascot_line: lines[question.question.length % lines.length],
      };
    } else {
      const userAnswer =
        choice !== null && isMcq(question) ? `Chose option ${choice + 1}: ${question.options[choice] ?? ""}` : answer;
      const context = `Concept: ${concept.name}\nSummary: ${concept.summary}\nKey excerpt: ${concept.excerpt}\n\nNote:\n${this.noteText(concept.note_path, 10_000)[1]}` +
        (target ? `\n\nMisconception being practised: ${target.text}` : "");
      const label = { guess: "just guessing", unsure: "somewhat unsure", sure: "confident" }[confidence];
      grade = await tutor.grade(this.claude(), question, userAnswer, label, context, images, target);
    }

    if (grade.misconception_id !== null && (!Number.isInteger(grade.misconception_id) || grade.misconception_id !== target?.id)) {
      throw new Error("Claude returned a diagnosis for an unrelated misconception.");
    }
    let misconception_id: number | null = null;
    let score = Math.min(1, Math.max(0, grade.score / 100));
    if (!grade.correct && confidence === "sure") score = 0; // confidently wrong: bring it back soon
    this.storeReview(concept, score);
    this.progress.logAttempt(concept.id, "quiz", score);
    if (target && grade.correct) this.progress.resolveMisconception(target.id);
    if (!grade.correct) {
      if (grade.misconception_id !== null) misconception_id = grade.misconception_id;
      else if (grade.misconception.trim()) misconception_id = this.progress.addMisconception(concept.id, grade.misconception);
    }
    return { grade, misconception_id };
  }

  async checkAnswer(a: {
    question: string;
    key: string;
    misconception: string;
    answer: string;
    misconceptionId: number | null;
    images?: ImageInput[];
  }): Promise<CheckResult> {
    const original = this.progress.openMisconceptions().find((m) => m.id === a.misconceptionId);
    const r = await tutor.check(this.claude(), a.question, a.key, original?.text ?? a.misconception, a.answer, a.images);
    if (r.understood && a.misconceptionId !== null) this.progress.resolveMisconception(a.misconceptionId);
    return r;
  }

  /** Free-form question to the tutor. `situation` describes the current step. */
  async askTutor(
    conceptId: number | null,
    situation: string,
    history: [boolean, string][],
    message: string,
    images: ImageInput[] = [],
  ): Promise<ChatReply> {
    const c = conceptId !== null ? this.progress.concept(conceptId) : undefined;
    let context: string;
    if (c) {
      const [title, body] = this.noteText(c.note_path, 20_000);
      context = `${situation}\n\nConcept "${c.name}" (${c.summary})\n\nNote "${title}":\n${body}`;
    } else {
      const names = this.concepts()
        .slice(0, 80)
        .map((x) => x.name);
      context = `${situation}\n\nConcepts in the learner's notes: ${names.join(", ")}`;
    }
    return tutor.chat(this.claude(), context, history, message, images);
  }

  // -------------------------------------------------------------------------
  // Teach

  /** Notes most relevant to a topic, by simple keyword overlap (titles and concepts weigh more). */
  relevantNotes(topic: string, limit = 3): string[] {
    const words = topic
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (!words.length) return [];
    const concepts = this.concepts();
    const scored = [...this.library.notes.values()].map((n) => {
      const title = n.title.toLowerCase();
      const body = n.body.toLowerCase();
      const names = concepts
        .filter((c) => c.note_path === n.key)
        .map((c) => c.name.toLowerCase())
        .join(" ");
      let score = 0;
      for (const w of words) {
        if (title.includes(w)) score += 5;
        if (names.includes(w)) score += 3;
        score += Math.min(5, body.split(w).length - 1);
      }
      return { key: n.key, score };
    });
    return scored
      .filter((x) => x.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.key);
  }

  async teach(
    topic: string,
    sources: string[],
    history: [boolean, string][],
    message: string,
    images: ImageInput[] = [],
  ): Promise<TeachReply> {
    const context = sources
      .map((k) => {
        const [title, body] = this.noteText(k, 8_000);
        return title ? `### Note "${title}"\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    return tutor.teach(this.claude(), topic, context, history, message, images);
  }

  /** Save a finished lesson as a note in the vault and open it. Returns its path. */
  async saveLesson(topic: string, summary: string, sources: string[]): Promise<string> {
    const folder = normalizePath(this.settings().lessonFolder || "Claude Tutor/Lessons");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const base = topic.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Lesson";
    let path = normalizePath(`${folder}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);
    const links = [...new Set(sources.map((k) => this.library.notes.get(k)?.path).filter((p): p is string => !!p))]
      .map((p) => `- [[${p.replace(/\.md$/, "")}]]`)
      .join("\n");
    const date = new Date().toISOString().slice(0, 10);
    const body = `---\ncreated: ${date}\ntags: [claude-tutor/lesson]\n---\n# ${topic}\n\n${summary.trim()}\n${links ? `\n## From your notes\n${links}\n` : ""}`;
    await this.app.vault.create(path, body);
    await this.app.workspace.openLinkText(path, "", "tab");
    return path;
  }

  resolveMistake(id: number): Snapshot {
    this.progress.resolveMisconception(id);
    return this.snapshot();
  }
}
