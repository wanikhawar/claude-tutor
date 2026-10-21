// What the UI calls, backed by the vault library and a JSON progress file.

import { TFile, normalizePath, type App } from "obsidian";
import { cancelled, type Provider, type RequestOptions } from "./core/cli";
import { listModels } from "./core/providers";
import { inertMarkdown } from "./core/inert";
import { chunks, clip, headings } from "./core/notes";
import { PART_CHARS } from "./core/pdf";
import { Progress } from "./core/progress";
import { review } from "./core/srs";
import * as tutor from "./core/tutor";
import {
  isMcq,
  type ChatReply,
  type CheckResult,
  type Concept,
  type Confidence,
  type ExtractedConcept,
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
import { modelName, type TutorSettings } from "./settings";

const STOPWORDS = new Set(
  "a an am as at be by do if in is it me my of on or so to up us we the and for with how why what when does work works about into from that this are was were you your teach explain learn understand want know".split(
    " ",
  ),
);

/** Concepts are read from a long note a piece of up to this many characters at a time (a PDF part fits in one). */
const EXTRACT_CHARS = PART_CHARS;

/** Max characters of one note sent with a request: past this, only its most relevant passages go. */
const NOTE_BUDGET = 100_000;
/** Max characters of note text in one lesson turn, shared by its notes. Fits every supported model. */
const TEACH_CHARS = 400_000;
/** Max characters of note text in one quiz request, shared by its notes. */
const QUIZ_CHARS = 300_000;
/** Size of the passages a long note is cut into when only part of it fits. */
const PASSAGE_CHARS = 4_000;

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
  /** When it was logged (ISO). */
  ts: string;
  /** The question being answered when Clawd spotted it, if known. */
  source: string;
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
  /** Reviews per day for the last 7 days, oldest first. */
  activity: number[];
  /** Consecutive study days. */
  streak: number;
  model: string;
  effort: string;
  provider: Provider;
  /** The models offered in the picker, in your order, with the names to show. */
  models: { provider: Provider; id: string; name: string }[];
  autoIndex: boolean;
  confirmAbove: number;
}

/** One turn of an Ask Clawd chat: from the learner?, the text, and the concept it was about. */
export type ChatTurn = [boolean, string, number | null];

export interface GradeOutcome {
  grade: Grade;
  misconception_id: number | null;
}

/**
 * Finds a topic word in lowercase text. Short words ("b5", "ph") must stand alone, or they'd
 * match inside most words; longer ones match anywhere, so "vitamin" finds "vitamins".
 */
function wordPattern(word: string): RegExp {
  // Topic words are only letters and digits, so they need no escaping.
  return new RegExp(word.length < 3 ? `(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])` : word, "gu");
}

/** How often `pattern` occurs in `text` without overlapping, counting no higher than `max`. */
function occurrences(text: string, pattern: RegExp, max: number): number {
  let n = 0;
  pattern.lastIndex = 0;
  while (n < max && pattern.exec(text)) n++;
  return n;
}

/** The words of a query worth matching, as patterns. */
function queryWords(query: string): RegExp[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(wordPattern);
}

/**
 * A note in at most `budget` characters. A note that fits goes whole. A longer one keeps the
 * passages that best match `query`, in note order, after an outline of all its headings so
 * Claude knows what else it covers.
 */
function passages(body: string, budget: number, query: RegExp[]): string {
  if (body.length <= budget) return body;
  const outline = clip(headings(body).join("\n"), Math.floor(budget / 10));
  const head = `[A long note: only the passages most relevant right now are included, and "[…]" marks the gaps. All its headings:\n${outline}]\n\n`;
  const pieces = chunks(body, PASSAGE_CHARS).map((text, i) => {
    const lower = text.toLowerCase();
    return { text, i, score: query.reduce((sum, w) => sum + occurrences(lower, w, 5), 0) };
  });
  // Best matches first; ties (including no match at all) in note order.
  const picked = new Set<number>();
  let left = budget - head.length;
  for (const p of [...pieces].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (p.text.length > left) continue;
    picked.add(p.i);
    left -= p.text.length;
  }
  let out = head;
  let last = -1;
  for (const p of pieces) {
    if (!picked.has(p.i)) continue;
    if (p.i !== last + 1) out += "\n[…]\n\n";
    out += p.text;
    last = p.i;
  }
  return last < pieces.length - 1 ? `${out}\n[…]` : out;
}

/** Split `total` characters between texts of these lengths: short ones whole, the rest evenly. */
function shares(lengths: number[], total: number): number[] {
  const out = lengths.map(() => 0);
  let left = total;
  const shortestFirst = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  shortestFirst.forEach((i, k) => {
    out[i] = Math.min(lengths[i], Math.floor(left / (shortestFirst.length - k)));
    left -= out[i];
  });
  return out;
}

export class Backend {
  private listeners = new Set<() => void>();
  private renameListeners = new Set<(oldPath: string, newPath: string) => void>();
  private requests = new AbortController();

  constructor(
    public app: App,
    public library: Library,
    public progress: Progress,
    private settings: () => TutorSettings,
    private cliCwd: string,
    private openSettingsTab: () => void,
    private saveSettings: () => Promise<void>,
  ) {}

  dispose() {
    this.requests.abort();
    this.listeners.clear();
    this.renameListeners.clear();
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

  /** Follow renamed files and folders: for what holds on to note keys, like an open lesson. */
  onRename(fn: (oldPath: string, newPath: string) => void): () => void {
    this.renameListeners.add(fn);
    return () => this.renameListeners.delete(fn);
  }

  /** A file or folder was renamed: its notes keep their progress, and whatever holds their keys follows them. */
  renamed(oldPath: string, newPath: string) {
    this.progress.rename(oldPath, newPath);
    for (const fn of this.renameListeners) fn(oldPath, newPath);
  }

  /** Ask a CLI which models it offers and remember the answer. */
  async discoverModels(provider: Provider) {
    const s = this.settings();
    // Tied to the backend's lifetime: a plugin reload mid-discovery mustn't save over the new instance's settings.
    const signal = this.requests.signal;
    const { version, models } = await listModels(provider, {
      path: provider === "codex" ? s.codexPath : s.claudePath,
      cwd: this.cliCwd,
      signal,
    });
    if (signal.aborted) return;
    s.discovered = [...s.discovered.filter((m) => m.provider !== provider), ...models];
    s.versions[provider] = version;
    if (provider === "claude") for (const m of models) if (m.resolved) s.resolvedModels[m.id] = m.resolved;
    await this.saveSettings();
  }

  async rescan() {
    await this.library.loadAll();
    this.emit();
  }

  private requestOptions(signal?: AbortSignal): RequestOptions {
    const s = this.settings();
    const alias = s.model;
    const codex = s.provider === "codex";
    return {
      provider: s.provider,
      path: codex ? s.codexPath : s.claudePath,
      model: alias,
      effort: s.effort,
      cwd: this.cliCwd,
      signal: signal ? AbortSignal.any([this.requests.signal, signal]) : this.requests.signal,
      // Remember which exact model the alias resolved to, so the picker can show it.
      onModel: (id) => {
        if (codex || s.resolvedModels[alias] === id) return;
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

  /** A note's title and text, cut to the passages that best match `query` if it's over `budget`. */
  private noteText(key: string, budget: number, query = ""): [string, string] {
    const n = this.library.notes.get(key);
    return n ? [n.title, passages(n.body, budget, queryWords(query))] : ["", ""];
  }

  private concepts(): Concept[] {
    return this.progress.conceptsFor(new Set(this.library.notes.keys()));
  }

  /** Whether a note is still in your library: its source wasn't removed or excluded, and the file is still there. */
  private stillInLibrary(key: string): boolean {
    const path = key.replace(/#p\d+-\d+$/, "");
    return this.library.inScope(path) && this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  /**
   * Whether a note's text may go with a request: you picked it for Clawd to read, and it's
   * still in your library. Checked on every request, so a source you remove stops being shared.
   */
  private shareable(key: string): boolean {
    return this.progress.noteHash(key) !== undefined && this.stillInLibrary(key);
  }

  /**
   * A concept to send with a request. One that a re-read just dropped still counts: the step
   * or question showing it was made before. Throws if its note is no longer in your library.
   */
  private concept(id: number): Concept {
    const c = this.progress.concept(id) ?? this.progress.droppedConcept(id);
    if (!c) throw new Error("That concept no longer exists.");
    if (!this.shareable(c.note_path)) throw new Error("That note is no longer in your library.");
    return c;
  }

  /** Still in your progress: a re-read can drop a concept while a request about it runs. */
  private current(c: Concept): boolean {
    return this.progress.concept(c.id) === c;
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
    const names = new Map(concepts.map((c) => [c.id, c.name]));
    return {
      vault: this.app.vault.getName(),
      configured: s.studyFolders.length > 0 || s.studyFiles.length > 0,
      sources: { folders: [...s.studyFolders], files: [...s.studyFiles] },
      // Not ones whose source was just removed, before the rescan drops them: nothing should read them now.
      notes: this.library
        .sorted()
        .filter((n) => this.stillInLibrary(n.key))
        .map((n) => ({
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
      mistakes: this.progress.openMisconceptions().flatMap((m) => {
        const concept_name = m.concept_id === null ? undefined : names.get(m.concept_id);
        return concept_name === undefined
          ? []
          : [{ id: m.id, concept_id: m.concept_id, concept_name, text: m.text, ts: m.ts, source: m.source ?? "" }];
      }),
      activity: this.progress.activity(7),
      streak: this.progress.streak(),
      model: s.model,
      effort: s.effort,
      provider: s.provider,
      models: s.models.map((m) => ({ provider: m.provider, id: m.id, name: modelName(s, m.provider, m.id) })),
      autoIndex: s.autoIndex,
      confirmAbove: s.confirmAbove,
    };
  }

  /** Have Claude read one note and extract its concepts. */
  async indexNote(key: string, signal?: AbortSignal): Promise<Snapshot> {
    const options = this.requestOptions(signal);
    await this.library.waitForFile(key);
    if (options.signal?.aborted) throw cancelled("Claude");
    const note = this.note(key);
    if (this.progress.isCurrent(key, note.hash)) return this.snapshot();
    // This note's own concepts go separately, so a re-read keeps their names (and progress).
    const current = this.progress.conceptsFor(new Set([key])).map((c) => c.name);
    const known = this.concepts()
      .filter((c) => c.note_path !== key)
      .map((c) => c.name)
      .slice(0, 200);
    // All of the note, a piece at a time so a long one gets the same attention throughout.
    // Only the concepts are kept.
    const parts = chunks(note.body, EXTRACT_CHARS);
    const list: ExtractedConcept[] = [];
    const seen = new Set<string>();
    for (const [i, text] of parts.entries()) {
      // Removed from your library while an earlier part was read: send no more of it.
      if (!this.stillInLibrary(key)) return this.snapshot();
      const part = { index: i + 1, count: parts.length, earlier: list.map((c) => c.name) };
      const { concepts } = await tutor.extractConcepts(options, note.title, text, known, part, current);
      if (options.signal?.aborted) throw cancelled("Claude");
      for (const c of concepts.slice(0, tutor.MAX_CONCEPTS)) {
        const name = c.name.trim().toLowerCase();
        if (seen.has(name)) continue;
        seen.add(name);
        list.push(c);
      }
    }
    await this.library.waitForFile(key);
    if (options.signal?.aborted) throw cancelled("Claude");
    // The note may have changed while Claude was reading; only store if it's the same version.
    if (this.library.notes.get(key)?.hash === note.hash) this.progress.saveConcepts(key, note.hash, list);
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
      return (
        (ext === "md" || (ext === "pdf" && this.settings().includePdfs)) &&
        !f.path.startsWith(this.app.vault.configDir + "/")
      );
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
    signal?: AbortSignal;
    followUp?: string;
  }): Promise<FeynmanEval> {
    const concept = this.concept(a.conceptId);
    const [noteTitle, noteBody] = this.noteText(concept.note_path, NOTE_BUDGET, `${concept.name} ${concept.excerpt}`);
    const ev = await tutor.evaluateFeynman(this.requestOptions(a.signal), {
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
      followUp: a.followUp,
    });
    const score = Math.min(1, Math.max(0, ev.score / 100));
    this.progress.logAttempt(a.conceptId, "feynman", score);
    // You still get the feedback; there's just no concept left to schedule or note mistakes on.
    if (!this.current(concept)) return ev;
    for (const g of ev.gaps.filter((g) => g.kind === "wrong"))
      this.progress.addMisconception(a.conceptId, g.issue, a.question);
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
    // Nothing is sent, so a concept a re-read dropped just isn't scheduled.
    const c = this.progress.concept(conceptId);
    this.progress.logAttempt(conceptId, `self-${kind}`, kind === "known" ? 0.7 : 0.6);
    if (c && kind === "known") this.storeReview(c, 0.7);
  }

  async makeQuiz(conceptIds: number[], count: number, signal?: AbortSignal): Promise<QuizSet> {
    const pool = conceptIds
      // A quiz planned before a re-read can still be made: grading accepts dropped concepts too.
      .map((id) => this.progress.concept(id) ?? this.progress.droppedConcept(id))
      .filter((c): c is Concept => !!c && this.shareable(c.note_path))
      .slice(0, 8);
    if (!pool.length) throw new Error("No concepts to quiz on yet.");
    // Each note once, sharing one limit, with the passages about its quizzed concepts.
    const paths = [...new Set(pool.map((c) => c.note_path))];
    const lengths = paths.map((p) => Math.min(NOTE_BUDGET, this.library.notes.get(p)?.body.length ?? 0));
    const budgets = new Map(shares(lengths, QUIZ_CHARS).map((b, i) => [paths[i], b]));
    const seen = new Set<string>();
    const materials = pool.map((c) => {
      const about = pool.filter((x) => x.note_path === c.note_path).map((x) => `${x.name} ${x.excerpt}`);
      const [noteTitle, body] = this.noteText(c.note_path, budgets.get(c.note_path) ?? 0, about.join(" "));
      const first = !seen.has(c.note_path);
      seen.add(c.note_path);
      return { concept: c, noteTitle, noteBody: first ? body : "(same note as above)" };
    });
    const ids = new Set(pool.map((c) => c.id));
    const misc = this.progress
      .openMisconceptions()
      .filter((m) => m.concept_id !== null && ids.has(m.concept_id))
      .slice(0, 10);
    const quiz = await tutor.makeQuiz(this.requestOptions(signal), materials, misc, Math.min(12, Math.max(1, count)));
    for (const q of quiz.questions) {
      const concept = pool.find((c) => c.id === q.concept_id);
      if (!concept) throw new Error("Claude returned a question for a concept outside this quiz.");
      q.concept = concept.name;
      const answer = q.correct_option;
      const valid = q.options.length >= 2 && Number.isInteger(answer) && answer >= 0 && answer < q.options.length;
      if (q.kind === "mcq" && !valid)
        throw new Error("Claude returned a multiple-choice question without a valid answer.");
      if (
        q.misconception_id !== null &&
        !misc.some((m) => m.id === q.misconception_id && m.concept_id === concept.id)
      ) {
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
    signal?: AbortSignal,
  ): Promise<GradeOutcome> {
    const concept = this.concept(question.concept_id);
    const target = this.progress
      .openMisconceptions()
      .find((m) => m.id === question.misconception_id && m.concept_id === concept.id);
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
      const context =
        `Concept: ${concept.name}\nSummary: ${concept.summary}\nKey excerpt: ${concept.excerpt}\n\nNote:\n${this.noteText(concept.note_path, NOTE_BUDGET, `${concept.name} ${concept.excerpt}`)[1]}` +
        (target ? `\n\nMisconception being practised: ${target.text}` : "");
      const label = { guess: "just guessing", unsure: "somewhat unsure", sure: "confident" }[confidence];
      grade = await tutor.grade(this.requestOptions(signal), question, userAnswer, label, context, images, target);
    }

    if (
      grade.misconception_id !== null &&
      (!Number.isInteger(grade.misconception_id) || grade.misconception_id !== target?.id)
    ) {
      throw new Error("Claude returned a diagnosis for an unrelated misconception.");
    }
    let misconception_id: number | null = null;
    let score = Math.min(1, Math.max(0, grade.score / 100));
    if (!grade.correct && confidence === "sure") score = 0; // confidently wrong: bring it back soon
    this.progress.logAttempt(concept.id, "quiz", score);
    // A re-read dropped the concept while grading: there's nothing left to schedule.
    if (!this.current(concept)) return { grade, misconception_id: null };
    this.storeReview(concept, score);
    if (target && grade.correct) this.progress.resolveMisconception(target.id);
    if (!grade.correct) {
      if (grade.misconception_id !== null) misconception_id = grade.misconception_id;
      else if (grade.misconception.trim())
        misconception_id = this.progress.addMisconception(concept.id, grade.misconception, question.question);
    }
    return { grade, misconception_id };
  }

  async checkAnswer(a: {
    conceptId: number;
    question: string;
    key: string;
    misconception: string;
    answer: string;
    misconceptionId: number | null;
    images?: ImageInput[];
    signal?: AbortSignal;
  }): Promise<CheckResult> {
    this.concept(a.conceptId);
    const original = this.progress.openMisconceptions().find((m) => m.id === a.misconceptionId);
    const r = await tutor.check(
      this.requestOptions(a.signal),
      a.question,
      a.key,
      original?.text ?? a.misconception,
      a.answer,
      a.images,
    );
    if (r.understood && a.misconceptionId !== null) this.progress.resolveMisconception(a.misconceptionId);
    return r;
  }

  /**
   * The part of an Ask Clawd chat that may still be sent. A turn about a note that has left
   * your library may quote it, and so may any turn after it, since each request carried the
   * turns before. So the history stops before that turn. The chat keeps what this returns,
   * so new turns are remembered again from there.
   */
  chatHistory(history: ChatTurn[]): ChatTurn[] {
    const shared = (id: number | null) => {
      const about = id === null ? undefined : (this.progress.concept(id) ?? this.progress.droppedConcept(id));
      return id === null || (!!about && this.shareable(about.note_path));
    };
    const cut = history.findIndex(([, , id]) => !shared(id));
    return cut < 0 ? history : history.slice(0, cut);
  }

  /** Free-form question to the tutor. `situation` describes the current step. */
  async askTutor(
    conceptId: number | null,
    situation: string,
    history: ChatTurn[],
    message: string,
    images: ImageInput[] = [],
    signal?: AbortSignal,
  ): Promise<ChatReply> {
    const c = conceptId !== null ? this.concept(conceptId) : undefined;
    const turns = this.chatHistory(history).map(([me, text]): [boolean, string] => [me, text]);
    let context: string;
    if (c) {
      const [title, body] = this.noteText(c.note_path, NOTE_BUDGET, `${c.name} ${c.excerpt} ${message}`);
      context = `${situation}\n\nConcept "${c.name}" (${c.summary})\n\nNote "${title}":\n${body}`;
    } else {
      const names = this.concepts()
        .slice(0, 80)
        .map((x) => x.name);
      context = `${situation}\n\nConcepts in the learner's notes: ${names.join(", ")}`;
    }
    return tutor.chat(this.requestOptions(signal), context, turns, message, images);
  }

  // -------------------------------------------------------------------------
  // Teach

  /** Notes most relevant to a topic, by simple keyword overlap (titles and concepts weigh more). */
  relevantNotes(topic: string, limit = 3): string[] {
    const words = queryWords(topic);
    if (!words.length) return [];
    const conceptNames = new Map<string, string[]>();
    for (const c of this.concepts()) {
      const list = conceptNames.get(c.note_path);
      if (list) list.push(c.name);
      else conceptNames.set(c.note_path, [c.name]);
    }
    // Only notes you picked for Clawd to read: the matches are sent with the lesson.
    const picked = [...this.library.notes.values()].filter((n) => this.shareable(n.key));
    const scored = picked.map((n) => {
      const title = n.title.toLowerCase();
      const body = n.body.toLowerCase();
      const names = (conceptNames.get(n.key) ?? []).join(" ").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (title.search(w) >= 0) score += 5;
        if (names.search(w) >= 0) score += 3;
        score += occurrences(body, w, 5);
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
    signal?: AbortSignal,
  ): Promise<TeachReply> {
    // Earlier replies can quote a lesson's notes, and the history goes with every turn: a
    // lesson whose note has left your library can't go on without sharing it again.
    if (history.length && sources.some((k) => !this.shareable(k))) {
      throw new Error(
        "A note this lesson was based on is no longer in your library, so Clawd can't continue it. Start a new lesson.",
      );
    }
    // Whole notes while they fit. Past that, the passages that match the lesson so far, picked
    // again every turn, so any part of a note comes in once the lesson reaches it.
    const keys = sources.filter((k) => this.shareable(k));
    const budgets = shares(
      keys.map((k) => this.library.notes.get(k)?.body.length ?? 0),
      TEACH_CHARS,
    );
    const query = [topic, ...history.slice(-2).map(([, text]) => text), message].join(" ");
    const context = keys
      .map((k, i) => {
        const [title, body] = this.noteText(k, budgets[i], query);
        return title ? `### Note "${title}"\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    return tutor.teach(this.requestOptions(signal), topic, context, history, message, images);
  }

  /** Save a finished lesson as a note in the vault and open it. Returns its path. */
  async saveLesson(topic: string, summary: string, sources: string[]): Promise<string> {
    const folder = normalizePath(this.settings().lessonFolder || "Claude Tutor/Lessons");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const base =
      topic
        .replace(/[\\/:*?"<>|#^[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "Lesson";
    let path = normalizePath(`${folder}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);
    const links = [...new Set(sources.map((k) => this.library.notes.get(k)?.path).filter((p): p is string => !!p))]
      .map((p) => `- [[${p.replace(/\.md$/, "")}]]`)
      .join("\n");
    const date = new Date().toISOString().slice(0, 10);
    // Obsidian shows the note itself, so nothing in it may load from the web (the topic too: it can be a concept name).
    const lesson = inertMarkdown(`# ${topic}\n\n${summary.trim()}`);
    const body = `---\ncreated: ${date}\ntags: [claude-tutor/lesson]\n---\n${lesson}\n${links ? `\n## From your notes\n${links}\n` : ""}`;
    await this.app.vault.create(path, body);
    await this.app.workspace.openLinkText(path, "", "tab");
    return path;
  }

  resolveMistake(id: number): Snapshot {
    this.progress.resolveMisconception(id);
    return this.snapshot();
  }

  reopenMistake(id: number): Snapshot {
    this.progress.reopenMisconception(id);
    return this.snapshot();
  }
}
