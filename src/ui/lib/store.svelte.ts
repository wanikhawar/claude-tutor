// Global UI state: library snapshot, navigation, background reading and Clawd's mood.
import type { Backend } from "../../backend";
import type { TutorSettings } from "../../settings";
import { isDue, isNew } from "../../core/srs";
import { Notice } from "obsidian";
import { api, errText, obsidianApp, setBackend, type Concept, type Mood, type Snapshot } from "./api";
import { ConceptPicker, FolderPicker, NotePicker } from "./pickers";

export { isDue, isNew };

export type View = { name: "today" } | { name: "session" } | { name: "teach" } | { name: "mistakes" } | { name: "library" };
export type Step = { kind: "explain"; conceptId: number } | { kind: "quiz"; conceptIds: number[]; count: number };
export interface Plan {
  id: number;
  title: string;
  steps: Step[];
}

export interface Choice {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}
export interface Dialog {
  title: string;
  body: string;
  choices: Choice[];
  resolve: (id: string | null) => void;
}
export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/** What the live study session exposes to the rest of the UI. */
export interface LiveSession {
  /** The learner has done something worth not throwing away. */
  unfinished(): boolean;
  /** e.g. "3 of 5 steps done". */
  describe(): string;
  /** Add an explain step right after the current one. */
  addExplain(conceptId: number): void;
}

/** Moods that settle back to idle after a while. */
const TRANSIENT: Mood[] = ["happy", "proud", "encouraging", "curious", "confused", "concerned"];
const SLEEP_AFTER_MS = 90_000;
/** Wait this long after an edit before re-reading changed notes (you may still be typing). */
const REINDEX_DELAY_MS = 20_000;

export class Store {
  snap = $state<Snapshot | null>(null);
  view = $state<View>({ name: "today" });
  error = $state<string | null>(null);
  indexing = $state<{ done: number; total: number; current: string } | null>(null);
  indexError = $state<string | null>(null);
  /** Number of notes waiting for the user's OK before Clawd reads them all. */
  confirmCount = $state<number | null>(null);
  plan = $state<Plan | null>(null);
  /** The concept the live session is on, for highlighting it elsewhere. */
  currentConceptId = $state<number | null>(null);
  /** A question waiting for the learner's answer (rendered by App). */
  dialog = $state<Dialog | null>(null);
  toast = $state<Toast | null>(null);
  session: LiveSession | null = null;
  /** Each tab's main action (submit / continue / send), triggered by Ctrl/Cmd+Enter. */
  primaryHandlers: Partial<Record<View["name"], () => void>> = {};

  mood = $state<Mood>("happy");
  line = $state("Hi, I'm Clawd! Let's learn something from your notes.");
  lineId = $state(0);
  sleeping = $state(false);

  private settings!: () => TutorSettings;
  private saveSettings!: () => Promise<void>;
  private moodAt = Date.now();
  private lastActivity = Date.now();
  private approvedBulk = false;
  private declinedBulk = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = true;
  private generation = 0;
  private reading = new AbortController();
  private indexTask: Promise<unknown> | null = null;
  private failedReads = new Set<string>();
  private studyRequest = 0;
  private nextPlanId = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  init(backend: Backend, settings: () => TutorSettings, saveSettings: () => Promise<void>) {
    this.dispose();
    this.disposed = false;
    this.reading = new AbortController();
    this.snap = null;
    this.error = null;
    this.indexError = null;
    this.confirmCount = null;
    this.plan = null;
    this.currentConceptId = null;
    this.view = { name: "today" };
    this.approvedBulk = false;
    this.declinedBulk = false;
    setBackend(backend);
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.unsubscribe = backend.subscribe(() => this.onLibraryChange());
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.studyRequest++;
    this.reading.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.dialog?.resolve(null);
    this.dialog = null;
    this.toast = null;
    this.session = null;
    this.timer = null;
    this.ticker = null;
    this.indexTask = null;
    this.indexing = null;
    this.failedReads.clear();
    this.primaryHandlers = {};
  }

  private active(generation: number) {
    return !this.disposed && this.generation === generation;
  }

  /** Track both bulk and requested reads so callers can wait for the current operation. */
  private runIndex<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const task = work().finally(() => {
      if (this.indexTask === task) this.indexTask = null;
      if (this.active(generation)) this.indexing = null;
    });
    this.indexTask = task;
    return task;
  }

  get concepts() {
    return this.snap?.concepts ?? [];
  }
  get notes() {
    return this.snap?.notes ?? [];
  }
  get mistakes() {
    return this.snap?.mistakes ?? [];
  }
  get configured() {
    return !!this.snap?.configured;
  }
  get liveMood(): Mood {
    return this.sleeping ? "sleepy" : this.mood;
  }

  /** Run the current main action. Returns false if there's nothing to do (so the key passes through). */
  primary(): boolean {
    const handler = this.primaryHandlers[this.view.name];
    if (!handler) return false;
    handler();
    return true;
  }

  async setModel(model: string) {
    this.settings().model = model;
    await this.saveSettings();
    await this.refresh();
    const name = this.snap?.modelNames[model] ?? model;
    this.say("proud", model ? `Switched to ${name}. Same Clawd, different brain.` : `Using ${name}.`);
  }

  async setEffort(effort: string) {
    this.settings().effort = effort;
    await this.saveSettings();
    await this.refresh();
    const lines: Record<string, string> = {
      "": "Back to the default effort.",
      low: "Quick mode. I'll keep it snappy.",
      medium: "A little more thought, coming up.",
      high: "Thinking caps on.",
      xhigh: "Going deep. Answers may take a bit longer.",
      max: "Maximum brainpower! This will be slower.",
    };
    this.say("proud", lines[effort] ?? `Effort: ${effort}.`);
  }

  // -------------------------------------------------------------------------
  // Dialogs and toasts

  /** Ask the learner to choose. Resolves to the chosen id, or null if dismissed. */
  confirm(title: string, body: string, choices: Choice[]): Promise<string | null> {
    this.dialog?.resolve(null);
    return new Promise((resolve) => {
      this.dialog = { title, body, choices, resolve };
    });
  }

  answer(id: string | null) {
    const d = this.dialog;
    this.dialog = null;
    d?.resolve(id);
  }

  notify(text: string, action?: Toast["action"], ms = 6_000) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const id = (this.toast?.id ?? 0) + 1;
    this.toast = { id, text, action };
    this.toastTimer = setTimeout(() => {
      if (this.toast?.id === id) this.toast = null;
    }, ms);
  }

  /** Run the toast's action (e.g. Undo) and dismiss it. */
  runToastAction() {
    // Take the action before clearing: the toast is reactive state.
    const action = this.toast?.action;
    this.toast = null;
    action?.run();
  }

  // -------------------------------------------------------------------------
  // Clawd

  say(mood: Mood, line?: string) {
    this.mood = mood;
    this.moodAt = Date.now();
    if (line && line.trim()) {
      this.line = line.trim();
      this.lineId++;
    }
    this.poke();
  }

  poke() {
    this.lastActivity = Date.now();
    if (this.sleeping) {
      this.sleeping = false;
      this.mood = "confused";
      this.moodAt = Date.now();
      this.line = "Huh? Oh! I was just… resting my eyes.";
      this.lineId++;
    }
  }

  private tick() {
    const now = Date.now();
    const age = now - this.moodAt;
    if (this.mood === "celebrating" && age > 6_000) {
      this.mood = "happy";
      this.moodAt = now;
    } else if (TRANSIENT.includes(this.mood) && age > 20_000) {
      this.mood = "idle";
      this.moodAt = now;
    }
    if (!this.sleeping && this.mood === "idle" && now - this.lastActivity > SLEEP_AFTER_MS) this.sleeping = true;
  }

  // -------------------------------------------------------------------------
  // Library and background reading

  async refresh() {
    const generation = this.generation;
    if (!this.active(generation)) return;
    try {
      const snap = await api.snapshot();
      if (this.active(generation)) this.snap = snap;
    } catch (e) {
      if (this.active(generation)) this.error = errText(e);
    }
  }

  private onLibraryChange() {
    const generation = this.generation;
    if (!this.active(generation)) return;
    const first = !this.snap;
    void this.refresh().then(() => {
      if (!this.active(generation)) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.indexAll(), first ? 0 : REINDEX_DELAY_MS);
    });
  }

  /** Notes Clawd should read: new ones, plus edited ones if auto re-reading is on. */
  private queue() {
    const auto = this.snap?.autoIndex ?? true;
    return this.notes.filter((n) => n.stale && (!n.indexed || auto));
  }

  async indexAll(force = false) {
    const generation = this.generation;
    while (this.indexTask && this.active(generation)) await this.indexTask;
    if (!this.active(generation) || !this.configured) return;
    return this.runIndex(() => this.readAll(force, generation));
  }

  private async readAll(force: boolean, generation: number) {
    let queue = this.queue();
    if (!queue.length) return;
    const limit = this.snap?.confirmAbove ?? 25;
    if (queue.length > limit && !force && !this.approvedBulk) {
      if (!this.declinedBulk) this.confirmCount = queue.length;
      return;
    }
    this.confirmCount = null;
    this.indexError = null;
    let done = 0;
    let total = queue.length;
    this.say("curious", `Reading ${total} note${total > 1 ? "s" : ""}…`);
    while (queue.length) {
      for (const note of queue) {
        if (!this.active(generation)) return;
        this.indexing = { done, total, current: note.title };
        try {
          const snap = await api.indexNote(note.key, this.reading.signal);
          if (!this.active(generation)) return;
          this.snap = snap;
          if (!snap.notes.find((n) => n.key === note.key)?.stale) this.failedReads.delete(note.key);
        } catch (e) {
          if (!this.active(generation)) return;
          this.failedReads.add(note.key);
          this.indexError = errText(e);
          this.indexing = null;
          this.say("confused", "I got stuck reading one of your notes.");
          return;
        }
        done++;
      }
      // Notes edited while we were reading get picked up too.
      queue = this.queue();
      total = done + queue.length;
      // Notes that turned up mid-run (e.g. the startup scan finishing) count toward the limit too.
      if (total > limit && !force && !this.approvedBulk) {
        this.indexing = null;
        if (!this.declinedBulk) this.confirmCount = queue.length;
        return;
      }
    }
    this.indexing = null;
    this.say("proud", `All read! I know ${this.concepts.length} concepts from your notes.`);
  }

  /** Pick a note or PDF from the vault and add it on its own. */
  pickNote() {
    new NotePicker(obsidianApp(), (p) => api.inLibrary(p), async (file) => {
      const keys = await api.addFile(file.path);
      if (!keys.length) {
        this.error = `Couldn't read ${file.name}: ${api.skippedReason(file.path) ?? "no text found"}`;
        return;
      }
      this.say("curious", `Added “${file.basename}”. Let me read it…`);
      new Notice(`Claude Tutor: added ${file.name}`);
    }).open();
  }

  pickFolder() {
    new FolderPicker(obsidianApp(), async (folder) => {
      const path = folder.isRoot() ? "/" : folder.path;
      await api.addFolder(path);
      this.say("curious", `Added ${path === "/" ? "the whole vault" : `“${folder.name}”`}.`);
    }).open();
  }

  async removeSource(path: string) {
    await api.removeSource(path);
    this.say("happy", "Removed it from your library. Your progress is kept if you add it back.");
  }

  /** First-run setup: study these folders. */
  async configure(folders: string[]) {
    this.settings().studyFolders = folders;
    await this.saveSettings();
    // Setup already showed how many notes this reads; don't ask again on Today.
    this.approvedBulk = true;
    this.say("curious", "Great choice! Let me read your notes…");
    await api.rescan();
  }

  confirmBulk(yes: boolean) {
    this.confirmCount = null;
    if (yes) {
      this.approvedBulk = true;
      void this.indexAll(true);
    } else {
      this.declinedBulk = true;
      this.say("happy", "No problem. Right-click any note → “Quiz me on this” and I'll read just that one.");
    }
  }

  async indexOne(key: string) {
    const generation = this.generation;
    while (this.indexTask && this.active(generation)) await this.indexTask;
    if (!this.active(generation)) return false;
    return this.runIndex(async () => {
      this.indexError = null;
      try {
        await this.refresh();
        if (!this.active(generation)) return false;
        const note = this.notes.find((n) => n.key === key);
        // A bulk read may already have brought this note up to date while we waited.
        if (note && !note.stale) {
          this.failedReads.delete(key);
          return true;
        }
        this.indexing = { done: 0, total: 1, current: note?.title ?? key };
        for (let attempt = 0; attempt < 3; attempt++) {
          const snap = await api.indexNote(key, this.reading.signal);
          if (!this.active(generation)) return false;
          this.snap = snap;
          const current = snap.notes.find((n) => n.key === key);
          if (!current) throw new Error("That note is no longer in the library.");
          if (!current.stale) {
            this.failedReads.delete(key);
            return true;
          }
        }
        throw new Error("That note keeps changing. Finish editing, then retry reading it.");
      } catch (e) {
        if (this.active(generation)) {
          this.failedReads.add(key);
          this.indexError = errText(e);
        }
        return false;
      }
    });
  }

  /** Retry the failed notes explicitly, even when automatic re-reading is disabled. */
  async retryIndexing() {
    const generation = this.generation;
    await this.refresh();
    if (!this.active(generation)) return;
    for (const key of [...this.failedReads]) {
      if (!this.notes.some((n) => n.key === key)) {
        this.failedReads.delete(key);
        continue;
      }
      if (!(await this.indexOne(key)) || !this.active(generation)) return;
    }
    this.indexError = null;
    await this.indexAll();
  }

  beginStudyRequest(): number {
    return ++this.studyRequest;
  }

  isCurrentStudyRequest(request: number): boolean {
    return !this.disposed && this.studyRequest === request;
  }

  /** From a command or file menu: read the note if needed, then quiz or explain it. */
  async studyNote(keys: string[], mode: "quiz" | "explain", request = this.beginStudyRequest()) {
    const generation = this.generation;
    const current = () => this.active(generation) && this.isCurrentStudyRequest(request);
    if (!current()) return;
    this.error = null;
    await this.refresh();
    if (!current()) return;
    for (const key of keys) {
      const n = this.notes.find((x) => x.key === key);
      if (!n || n.stale) {
        this.say("thinking", `Reading “${n?.title ?? key}” first…`);
        const success = await this.indexOne(key);
        if (!current()) return;
        if (!success) {
          this.say("confused", "I couldn't read that note.");
          this.error = this.indexError;
          return;
        }
      }
    }
    const set = new Set(keys);
    const concepts = this.concepts.filter((c) => set.has(c.note_path));
    if (!concepts.length) {
      this.say("confused", "I couldn't find anything to teach in that note.");
      return;
    }
    const title = this.notes.find((n) => n.key === keys[0])?.title.replace(/ · pp?\..*$/, "") ?? "note";
    if (mode === "quiz") this.startQuiz(`Quiz: ${title}`, concepts.map((c) => c.id), this.settings().quizQuestions || 5);
    else {
      const next = concepts.find((c) => isDue(c)) ?? [...concepts].sort((a, b) => a.mastery - b.mastery)[0];
      this.startExplain(next.id);
    }
  }

  // -------------------------------------------------------------------------
  // Planning

  dueConcepts(): Concept[] {
    const now = Date.now();
    return this.concepts
      .filter((c) => isDue(c, now))
      .sort((a, b) => {
        if (isNew(a) !== isNew(b)) return isNew(a) ? 1 : -1;
        return (a.due ?? "").localeCompare(b.due ?? "");
      });
  }

  weakConcepts(): Concept[] {
    return this.concepts.filter((c) => !isNew(c)).sort((a, b) => a.mastery - b.mastery);
  }

  studyPlan(): Step[] {
    const s = this.settings();
    const due = this.dueConcepts();
    const explain = (due.length ? due : this.weakConcepts()).slice(0, s.explainPerSession);
    const pool = unique([...due.slice(0, 6), ...this.weakConcepts().slice(0, 4)].map((c) => c.id)).slice(0, 6);
    const steps: Step[] = explain.map((c) => ({ kind: "explain", conceptId: c.id }));
    if (pool.length && s.quizQuestions > 0) steps.push({ kind: "quiz", conceptIds: pool, count: s.quizQuestions });
    return steps;
  }

  /**
   * Start a new session. If one is under way, ask first: keep it, replace it, or
   * (for a single concept) add the concept to it.
   */
  async start(title: string, steps: Step[], addable?: number) {
    const request = this.beginStudyRequest();
    if (!steps.length) {
      this.say("confused", "I don't have any concepts for that yet.");
      return;
    }
    const live = this.plan && this.session?.unfinished() ? this.session : null;
    if (live) {
      const choices: Choice[] = [{ id: "keep", label: "Keep going" }];
      if (addable !== undefined) choices.push({ id: "add", label: "Add to this session", primary: true });
      choices.push({ id: "new", label: "Start new", danger: true, primary: addable === undefined });
      const pick = await this.confirm(
        "You're in the middle of a session",
        `${live.describe()}. Starting “${title}” ends it; what you've answered so far is already saved.`,
        choices,
      );
      if (!this.isCurrentStudyRequest(request) || this.session !== live) return;
      if (pick === "add" && addable !== undefined) {
        live.addExplain(addable);
        this.view = { name: "session" };
        this.say("happy", `Added “${this.concept(addable)?.name ?? "that"}” right after this step.`);
        return;
      }
      if (pick !== "new") {
        this.view = { name: "session" };
        return;
      }
    }
    this.plan = { id: ++this.nextPlanId, title, steps };
    this.view = { name: "session" };
  }

  startStudy() {
    void this.start("Study session", this.studyPlan());
  }

  endSession() {
    this.beginStudyRequest();
    this.plan = null;
    this.currentConceptId = null;
    this.view = { name: "today" };
  }

  /** End the session, asking first if the learner would lose anything. */
  async requestEnd() {
    const live = this.session;
    if (this.plan && live?.unfinished()) {
      const pick = await this.confirm(
        "End this session?",
        `${live.describe()}. Your answers so far are saved, but the rest of the session (and anything you've typed) is dropped.`,
        [
          { id: "keep", label: "Keep going" },
          { id: "end", label: "End session", danger: true, primary: true },
        ],
      );
      if (pick !== "end" || this.session !== live) return;
    }
    this.endSession();
  }

  startExplain(conceptId: number) {
    const c = this.concept(conceptId);
    void this.start(c ? `Explain: ${c.name}` : "Explain", [{ kind: "explain", conceptId }], conceptId);
  }

  /** Search all concepts and explain the chosen one. */
  pickConcept() {
    new ConceptPicker(obsidianApp(), this.concepts, (k) => this.noteTitle(k), (c) => this.startExplain(c.id)).open();
  }

  startQuiz(title: string, conceptIds: number[], count = 5) {
    void this.start(title, conceptIds.length ? [{ kind: "quiz", conceptIds: shuffle(conceptIds).slice(0, 8), count }] : []);
  }

  quickQuiz() {
    const due = this.dueConcepts().map((c) => c.id);
    this.startQuiz("Quick quiz", due.length >= 3 ? due : this.concepts.map((c) => c.id), 5);
  }

  mistakesQuiz() {
    const ids = unique(this.mistakes.map((m) => m.concept_id).filter((x): x is number => x !== null));
    this.startQuiz("Fix my mistakes", ids, Math.min(6, Math.max(3, ids.length)));
  }

  noteQuiz(key: string) {
    const note = this.notes.find((n) => n.key === key);
    this.startQuiz(`Quiz: ${note?.title ?? "note"}`, this.concepts.filter((c) => c.note_path === key).map((c) => c.id), 5);
  }

  concept(id: number) {
    return this.concepts.find((c) => c.id === id);
  }

  conceptByName(name: string) {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    return (
      this.concepts.find((c) => c.name.toLowerCase() === n) ??
      this.concepts.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))
    );
  }

  noteTitle(key: string) {
    return this.notes.find((n) => n.key === key)?.title ?? "";
  }

  openNote(key: string, page?: number) {
    void api.openNote(key, page).catch((e) => (this.error = errText(e)));
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const store = new Store();
