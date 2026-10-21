// Global UI state: library snapshot, navigation, background reading and Clawd's mood.
import type { Backend } from "../../backend";
import type { TutorSettings } from "../../settings";
import type { Provider } from "../../core/cli";
import { remapPath } from "../../core/paths";
import { isDue, isNew } from "../../core/srs";
import { Notice } from "obsidian";
import { api, errText, isCancel, obsidianApp, setBackend, type Concept, type Mood, type Snapshot } from "./api";
import { ConceptPicker, FolderPicker, NotePicker } from "./pickers";

export { isNew };

export type View =
  { name: "today" } | { name: "session" } | { name: "teach" } | { name: "mistakes" } | { name: "library" };
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

/** Move the keys under a renamed file or folder to their new paths. */
function remapKeys(keys: Set<string>, from: string, to: string) {
  for (const key of [...keys]) {
    const moved = remapPath(key, from, to);
    if (moved === key) continue;
    keys.delete(key);
    keys.add(moved);
  }
}

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
  /**
   * Moved on when the time alone changes what's due: a review falls due or a new day starts.
   * Reading it (see `isDue`) keeps a view that stays open, like Today, up to date.
   */
  clock = $state(Date.now());

  // Rebuilt only when the snapshot changes, so lookups in templates don't scan every concept.
  private conceptById = $derived(new Map(this.concepts.map((c) => [c.id, c])));
  private noteByKey = $derived(new Map(this.notes.map((n) => [n.key, n])));
  /** When `clock` next moves: the next review to fall due, or midnight. */
  private nextChange = $derived.by(() => {
    const midnight = new Date(this.clock);
    midnight.setHours(24, 0, 0, 0);
    let next = midnight.getTime();
    for (const c of this.concepts) {
      const due = c.due ? Date.parse(c.due) : NaN;
      if (due > this.clock && due < next) next = due;
    }
    return next;
  });

  private settings!: () => TutorSettings;
  private saveSettings!: () => Promise<void>;
  private moodAt = Date.now();
  private lastActivity = Date.now();
  /** The edited notes the confirmation is asking about, and the ones you said yes or no to. */
  private askedBulk: string[] = [];
  private approvedBulk = new Set<string>();
  private declinedBulk = new Set<string>();
  /**
   * Notes you picked for Clawd to read that it hasn't read yet. Once read, a note is like any
   * other: edits to it are re-read only as the auto re-read and confirmation settings say.
   */
  private picked = new Set<string>();
  private timer: number | null = null;
  private ticker: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = true;
  private generation = 0;
  private reading = new AbortController();
  private indexTask: Promise<unknown> | null = null;
  private failedReads = new Set<string>();
  private studyRequest = 0;
  private nextPlanId = 0;
  private toastTimer: number | null = null;

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
    this.clock = Date.now();
    this.askedBulk = [];
    this.approvedBulk = new Set();
    this.declinedBulk = new Set();
    this.picked = new Set();
    setBackend(backend);
    this.settings = settings;
    this.saveSettings = saveSettings;
    const unsubscribe = backend.subscribe(() => this.onLibraryChange());
    const unfollow = backend.onRename((from, to) => this.onRename(from, to));
    this.unsubscribe = () => {
      unsubscribe();
      unfollow();
    };
    this.ticker = window.setInterval(() => this.tick(), 1000);
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.studyRequest++;
    this.reading.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.ticker) window.clearInterval(this.ticker);
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
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

  async setModel(provider: Provider, model: string) {
    this.settings().provider = provider;
    this.settings().model = model;
    await this.saveSettings();
    await this.refresh();
    const name = this.snap?.models.find((m) => m.provider === provider && m.id === model)?.name ?? model;
    this.say("proud", model ? `Switched to ${name}. Same Clawd, different brain.` : `Using ${name}.`);
  }

  async setEffort(effort: string) {
    this.settings().effort = effort;
    await this.saveSettings();
    await this.refresh();
    const lines: Record<string, string> = {
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
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    const id = (this.toast?.id ?? 0) + 1;
    this.toast = { id, text, action };
    this.toastTimer = window.setTimeout(() => {
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
    if (now >= this.nextChange) {
      const newDay = new Date(now).toDateString() !== new Date(this.clock).toDateString();
      this.clock = now;
      // The week's activity and the streak are counted when the snapshot is taken.
      if (newDay) void this.refresh();
    }
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
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.indexAll(), first ? 0 : REINDEX_DELAY_MS);
    });
  }

  /** A renamed note is still the same note: it stays picked, approved, declined or failed. */
  private onRename(from: string, to: string) {
    for (const keys of [this.picked, this.approvedBulk, this.declinedBulk, this.failedReads]) remapKeys(keys, from, to);
    this.askedBulk = this.askedBulk.map((key) => remapPath(key, from, to));
  }

  /**
   * Note keys that follow renames until `stop()`: a note renamed while a command waits for a
   * read is still the note you asked about.
   */
  private follow(keys: string[]) {
    const live = [...keys];
    const stop = api.onRename((from, to) => live.forEach((key, i) => (live[i] = remapPath(key, from, to))));
    return { keys: live, stop };
  }

  /**
   * Notes Clawd should read: the ones you picked, plus ones it already read that you've since
   * edited (if auto re-reading is on). New notes are never read until you pick them.
   */
  private queue() {
    const auto = this.snap?.autoIndex ?? true;
    return this.notes.filter((n) => n.stale && (this.picked.has(n.key) || (n.indexed && auto)));
  }

  /** Notes in the library that Clawd has never read; you choose which of these to read. */
  get unread() {
    return this.notes.filter((n) => n.stale && !n.indexed);
  }

  async indexAll() {
    const generation = this.generation;
    while (this.indexTask && this.active(generation)) await this.indexTask;
    if (!this.active(generation) || !this.configured) return;
    return this.runIndex(() => this.readAll(generation));
  }

  /** A note is up to date: it's no longer waiting to be read or retried. */
  private readDone(key: string) {
    this.failedReads.delete(key);
    this.picked.delete(key);
    this.approvedBulk.delete(key);
    this.declinedBulk.delete(key);
  }

  /** Read the notes you picked (and finish any earlier picks that haven't been read yet). */
  async readSelected(keys: string[]) {
    for (const key of keys) this.picked.add(key);
    await this.indexAll();
  }

  private async readAll(generation: number) {
    const limit = this.snap?.confirmAbove ?? 25;
    // Each note is read at most once per pass; one edited again meanwhile waits for the next pass,
    // so a note you keep typing in isn't re-read back to back.
    const read = new Set<string>();
    // Notes you picked or approved are read. Lots of other edited ones wait for your OK, but don't hold up the rest.
    const next = () => {
      const approved = (key: string) => this.picked.has(key) || this.approvedBulk.has(key);
      // Edited notes you said "Not now" to wait until you ask for them, however few are left.
      const all = this.queue().filter((n) => !read.has(n.key) && (approved(n.key) || !this.declinedBulk.has(n.key)));
      const edited = all.filter((n) => !approved(n.key));
      if (edited.length <= limit) {
        this.confirmCount = null;
        return all.map((n) => n.key);
      }
      this.askedBulk = edited.map((n) => n.key);
      this.confirmCount = edited.length;
      return all.filter((n) => approved(n.key)).map((n) => n.key);
    };
    let queue = next();
    if (!queue.length) return;
    // A note renamed while it waits is read under its new name.
    const unfollow = api.onRename((from, to) => {
      queue = queue.map((key) => remapPath(key, from, to));
      remapKeys(read, from, to);
    });
    try {
      this.indexError = null;
      let done = 0;
      let total = queue.length;
      this.say("curious", `Reading ${total} note${total > 1 ? "s" : ""}…`);
      while (queue.length) {
        for (let i = 0; i < queue.length; i++) {
          if (!this.active(generation)) return;
          const key = queue[i];
          const note = this.note(key);
          // Moved out of the library, or not loaded under its new name yet: a later pass reads it.
          if (!note) continue;
          this.indexing = { done, total, current: note.title };
          read.add(key);
          try {
            const snap = await api.indexNote(key, this.reading.signal);
            if (!this.active(generation)) return;
            this.snap = snap;
            if (!snap.notes.find((n) => n.key === key)?.stale) this.readDone(key);
          } catch (e) {
            if (!this.active(generation)) return;
            this.failedReads.add(key);
            this.indexError = errText(e);
            this.indexing = null;
            this.say("confused", "I got stuck reading one of your notes.");
            return;
          }
          done++;
        }
        // Other notes edited while we were reading get picked up too.
        queue = next();
        total = done + queue.length;
      }
      this.indexing = null;
      this.say("proud", `All read! I know ${this.concepts.length} concepts from your notes.`);
    } finally {
      unfollow();
    }
  }

  /** Pick a note or PDF from the vault and add it on its own. */
  pickNote() {
    new NotePicker(
      obsidianApp(),
      (p) => api.inLibrary(p),
      async (file) => {
        const keys = await api.addFile(file.path);
        if (!keys.length) {
          this.error = `Couldn't read ${file.name}: ${api.skippedReason(file.path) ?? "no text found"}`;
          return;
        }
        this.say("curious", `Added “${file.basename}”. Let me read it…`);
        new Notice(`Claude Tutor: added ${file.name}`);
        // You picked this one note, so reading it is what you asked for.
        await this.readSelected(keys);
      },
    ).open();
  }

  pickFolder() {
    new FolderPicker(obsidianApp(), async (folder) => {
      const path = folder.isRoot() ? "/" : folder.path;
      await api.addFolder(path);
      this.say(
        "curious",
        `Added ${path === "/" ? "the whole vault" : `“${folder.name}”`}. Pick the notes you want me to read.`,
      );
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
    await api.rescan();
    this.say("curious", "Great choice! Now pick the notes you want me to read.");
  }

  confirmBulk(yes: boolean) {
    this.confirmCount = null;
    if (yes) {
      // Approves the notes it asked about: more edits arriving later are counted afresh.
      for (const key of this.askedBulk) this.approvedBulk.add(key);
      void this.indexAll();
    } else {
      for (const key of this.askedBulk) this.declinedBulk.add(key);
      this.say("happy", "No problem. I'll leave your edited notes as they are until you ask me to re-read them.");
    }
  }

  async indexOne(requested: string) {
    const generation = this.generation;
    const followed = this.follow([requested]);
    const key = () => followed.keys[0];
    try {
      while (this.indexTask && this.active(generation)) await this.indexTask;
      if (!this.active(generation)) return false;
      return await this.runIndex(async () => {
        this.indexError = null;
        try {
          await this.refresh();
          if (!this.active(generation)) return false;
          const note = this.note(key());
          // A bulk read may already have brought this note up to date while we waited.
          if (note && !note.stale) {
            this.readDone(key());
            return true;
          }
          this.indexing = { done: 0, total: 1, current: note?.title ?? key() };
          for (let attempt = 0; attempt < 3; attempt++) {
            const reading = key();
            // Renamed while it was read, or while its file was: read it again under the new name.
            const renamed = () => key() !== reading;
            let snap: Snapshot;
            try {
              snap = await api.indexNote(reading, this.reading.signal);
            } catch (e) {
              if (renamed() && !isCancel(e)) continue;
              throw e;
            }
            if (!this.active(generation)) return false;
            this.snap = snap;
            const current = snap.notes.find((n) => n.key === key());
            if (!current && renamed()) continue;
            if (!current) throw new Error("That note is no longer in the library.");
            if (!current.stale) {
              this.readDone(key());
              return true;
            }
          }
          throw new Error("That note keeps changing. Finish editing, then retry reading it.");
        } catch (e) {
          if (this.active(generation)) {
            this.failedReads.add(key());
            this.indexError = errText(e);
          }
          return false;
        }
      });
    } finally {
      followed.stop();
    }
  }

  /** Retry the failed notes explicitly, even when automatic re-reading is disabled. */
  async retryIndexing() {
    const generation = this.generation;
    await this.refresh();
    if (!this.active(generation)) return;
    for (const key of [...this.failedReads]) {
      if (!this.note(key)) {
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
  async studyNote(requested: string[], mode: "quiz" | "explain", request = this.beginStudyRequest()) {
    const followed = this.follow(requested);
    try {
      await this.studyFollowed(followed.keys, mode, request);
    } finally {
      followed.stop();
    }
  }

  /** `studyNote` with `keys` kept up to date as notes are renamed. */
  private async studyFollowed(keys: string[], mode: "quiz" | "explain", request: number) {
    const generation = this.generation;
    const current = () => this.active(generation) && this.isCurrentStudyRequest(request);
    if (!current()) return;
    this.error = null;
    await this.refresh();
    if (!current()) return;
    for (let i = 0; i < keys.length; i++) {
      const n = this.note(keys[i]);
      if (!n || n.stale) {
        this.say("thinking", `Reading “${n?.title ?? keys[i]}” first…`);
        const success = await this.indexOne(keys[i]);
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
    const title = this.note(keys[0])?.title.replace(/ · pp?\..*$/, "") ?? "note";
    if (mode === "quiz")
      this.startQuiz(
        `Quiz: ${title}`,
        concepts.map((c) => c.id),
        this.settings().quizQuestions || 5,
      );
    else {
      const next = concepts.find((c) => isDue(c)) ?? [...concepts].sort((a, b) => a.mastery - b.mastery)[0];
      this.startExplain(next.id);
    }
  }

  // -------------------------------------------------------------------------
  // Planning

  /** Due now, for views: recomputed when a review falls due, not only when progress changes. */
  isDue(c: Concept): boolean {
    void this.clock; // read for the dependency; the time is checked fresh
    return isDue(c);
  }

  dueConcepts(): Concept[] {
    return this.concepts
      .filter((c) => this.isDue(c))
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
    new ConceptPicker(
      obsidianApp(),
      this.concepts,
      (k) => this.noteTitle(k),
      (c) => this.startExplain(c.id),
    ).open();
  }

  startQuiz(title: string, conceptIds: number[], count = 5) {
    void this.start(
      title,
      conceptIds.length ? [{ kind: "quiz", conceptIds: shuffle(conceptIds).slice(0, 8), count }] : [],
    );
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
    this.startQuiz(
      `Quiz: ${this.note(key)?.title ?? "note"}`,
      this.concepts.filter((c) => c.note_path === key).map((c) => c.id),
      5,
    );
  }

  concept(id: number) {
    return this.conceptById.get(id);
  }

  note(key: string) {
    return this.noteByKey.get(key);
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
    return this.note(key)?.title ?? "";
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
