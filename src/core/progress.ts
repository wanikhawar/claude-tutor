// Progress store: indexed notes, concepts with spaced-repetition state, attempts
// and the misconception log, stored as JSON in the plugin folder.

import type { Concept, ExtractedConcept } from "./types";
import { remapPath } from "./paths";

export interface Misconception {
  id: number;
  concept_id: number | null;
  text: string;
  resolved: boolean;
  ts: string;
  /** The question being answered when the misconception was spotted. */
  source?: string;
}

interface Attempt {
  concept_id: number | null;
  kind: string;
  score: number;
  ts: string;
}

export interface ProgressData {
  version: 1;
  nextId: number;
  notes: Record<string, { hash: string; indexed_at: string; v?: number }>;
  concepts: Concept[];
  attempts: Attempt[];
  misconceptions: Misconception[];
}

/**
 * Bump when concept extraction changes in a way worth re-reading notes for.
 * 2: concepts are specific ideas with focused questions (not headings).
 */
export const EXTRACT_VERSION = 2;

/** Old attempts beyond this are dropped; only recent ones are shown or counted. */
const MAX_ATTEMPTS = 5_000;

function cleanQuestions(qs: string[] | undefined): string[] {
  return (qs ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 4);
}

/** The question to ask about a concept now: rotates through its questions on each review. */
export function conceptQuestion(c: Concept): string {
  const qs = c.questions ?? [];
  if (!qs.length) return `Explain ${c.name} in your own words.`;
  return qs[(c.reps + c.lapses) % qs.length];
}

export function emptyProgress(): ProgressData {
  return { version: 1, nextId: 1, notes: {}, concepts: [], attempts: [], misconceptions: [] };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const str = (x: unknown) => (typeof x === "string" ? x : "");
const strOrNull = (x: unknown) => (typeof x === "string" ? x : null);
const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/**
 * Read a saved progress file. Throws if it isn't one: valid JSON of the wrong shape (say
 * `{"concepts":null}`) would otherwise crash the plugin later, with no backup made.
 * What identifies a record (ids, note paths, names) must be right; any other field that
 * studying or scheduling reads is given its default if it's missing or the wrong type.
 */
export function parseProgress(text: string): ProgressData {
  const raw: unknown = JSON.parse(text);
  const fail = (what: string): never => {
    throw new Error(`not a progress file (${what})`);
  };
  if (!isObject(raw)) fail("not an object");
  const v = raw as Record<string, unknown>;
  // `read` returns undefined for a record that breaks the file.
  const list = <T>(key: string, read: (x: Record<string, unknown>) => T | undefined): T[] => {
    if (v[key] === undefined) return [];
    if (!Array.isArray(v[key])) fail(`bad ${key}`);
    return (v[key] as unknown[]).map((x) => {
      const r = isObject(x) ? read(x) : undefined;
      return r === undefined ? fail(`bad ${key}`) : r;
    });
  };
  if (v.nextId !== undefined && !isId(v.nextId)) fail("bad nextId");
  if (v.notes !== undefined && !isObject(v.notes)) fail("bad notes");
  const notes: ProgressData["notes"] = {};
  for (const [key, n] of Object.entries((v.notes ?? {}) as Record<string, unknown>)) {
    if (!isObject(n) || typeof n.hash !== "string") fail("bad notes");
    const note = n as Record<string, unknown>;
    notes[key] = { ...note, hash: note.hash as string, indexed_at: str(note.indexed_at), v: typeof note.v === "number" ? note.v : undefined };
  }
  const concepts = list<Concept>("concepts", (c) =>
    isId(c.id) && typeof c.note_path === "string" && typeof c.name === "string"
      ? {
          ...(c as unknown as Concept),
          summary: str(c.summary),
          prerequisites: strs(c.prerequisites),
          excerpt: str(c.excerpt),
          questions: strs(c.questions),
          ease: num(c.ease, 2.5),
          interval_days: num(c.interval_days, 0),
          reps: num(c.reps, 0),
          lapses: num(c.lapses, 0),
          due: strOrNull(c.due),
          mastery: num(c.mastery, 0),
          last_reviewed: strOrNull(c.last_reviewed),
        }
      : undefined,
  );
  const misconceptions = list<Misconception>("misconceptions", (m) =>
    isId(m.id) && typeof m.text === "string"
      ? { ...(m as unknown as Misconception), concept_id: isId(m.concept_id) ? m.concept_id : null, resolved: m.resolved === true, ts: str(m.ts), source: typeof m.source === "string" ? m.source : undefined }
      : undefined,
  );
  // An attempt without a time can't count towards anything, so it's left out.
  const attempts = list<Attempt | null>("attempts", (a) =>
    typeof a.ts === "string" ? { concept_id: isId(a.concept_id) ? a.concept_id : null, kind: str(a.kind), score: num(a.score, 0), ts: a.ts } : null,
  ).filter((a): a is Attempt => a !== null);
  // New ids must not collide with saved ones, even if nextId was lost.
  const ids = [...concepts, ...misconceptions].map((x) => x.id);
  const nextId = Math.max((v.nextId as number | undefined) ?? 1, ...ids.map((id) => id + 1));
  return { ...(v as unknown as ProgressData), version: 1, nextId, notes, concepts, attempts, misconceptions };
}

export class Progress {
  /**
   * Concepts a re-read dropped (renamed or gone from the note), kept until the plugin
   * reloads: a lesson step or quiz question may still be showing one. Not saved.
   */
  private dropped = new Map<number, Concept>();

  constructor(
    public data: ProgressData,
    /** Called after every change; the plugin debounces it into a file write. */
    private onChange: () => void = () => {},
  ) {
    for (const c of data.concepts) c.questions ??= [];
  }

  private changed() {
    this.onChange();
  }

  noteHash(key: string): string | undefined {
    return this.data.notes[key]?.hash;
  }

  /** Read with the current extraction rules and unchanged since. */
  isCurrent(key: string, hash: string): boolean {
    const n = this.data.notes[key];
    return !!n && n.hash === hash && (n.v ?? 1) >= EXTRACT_VERSION;
  }

  /**
   * Store freshly extracted concepts for a note. Progress on concepts whose name is
   * unchanged is preserved; concepts that disappeared are removed.
   */
  saveConcepts(notePath: string, hash: string, list: ExtractedConcept[]) {
    const keep = new Set<string>();
    for (const e of list) {
      const name = e.name.trim();
      keep.add(name);
      const existing = this.data.concepts.find((c) => c.note_path === notePath && c.name === name);
      if (existing) {
        existing.summary = e.summary;
        existing.prerequisites = e.prerequisites ?? [];
        existing.excerpt = e.excerpt ?? "";
        existing.questions = cleanQuestions(e.questions);
      } else {
        this.data.concepts.push({
          id: this.data.nextId++,
          note_path: notePath,
          name,
          summary: e.summary,
          prerequisites: e.prerequisites ?? [],
          excerpt: e.excerpt ?? "",
          questions: cleanQuestions(e.questions),
          ease: 2.5,
          interval_days: 0,
          reps: 0,
          lapses: 0,
          due: null,
          mastery: 0,
          last_reviewed: null,
        });
      }
    }
    this.data.concepts = this.data.concepts.filter((c) => {
      const gone = c.note_path === notePath && !keep.has(c.name);
      if (gone) this.dropped.set(c.id, c);
      return !gone;
    });
    this.data.notes[notePath] = { hash, indexed_at: new Date().toISOString(), v: EXTRACT_VERSION };
    this.changed();
  }

  conceptsFor(keys: Set<string>): Concept[] {
    return this.data.concepts.filter((c) => keys.has(c.note_path));
  }

  concept(id: number): Concept | undefined {
    return this.data.concepts.find((c) => c.id === id);
  }

  /** A concept a re-read dropped since the plugin loaded (see `dropped`). */
  droppedConcept(id: number): Concept | undefined {
    return this.dropped.get(id);
  }

  touch() {
    this.changed();
  }

  /** Keep progress when a file or folder is renamed (including split PDFs). */
  rename(oldPath: string, newPath: string) {
    let any = false;
    for (const c of this.data.concepts) {
      const k = remapPath(c.note_path, oldPath, newPath);
      if (k !== c.note_path) {
        c.note_path = k;
        any = true;
      }
    }
    // Not saved, so no change to record: a quiz planned before the re-read still needs them.
    for (const c of this.dropped.values()) c.note_path = remapPath(c.note_path, oldPath, newPath);
    for (const key of Object.keys(this.data.notes)) {
      const k = remapPath(key, oldPath, newPath);
      if (k !== key) {
        this.data.notes[k] = this.data.notes[key];
        delete this.data.notes[key];
        any = true;
      }
    }
    if (any) this.changed();
  }

  logAttempt(conceptId: number | null, kind: string, score: number) {
    this.data.attempts.push({ concept_id: conceptId, kind, score, ts: new Date().toISOString() });
    if (this.data.attempts.length > MAX_ATTEMPTS) this.data.attempts.splice(0, this.data.attempts.length - MAX_ATTEMPTS);
    this.changed();
  }

  /** Attempts per local calendar day for the last `days` days, oldest first (today last). */
  activity(days = 7, now = new Date()): number[] {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
    const out = new Array<number>(days).fill(0);
    for (const a of this.data.attempts) {
      const d = new Date(a.ts);
      const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - start) / 86_400_000);
      if (day >= 0 && day < days) out[day]++;
    }
    return out;
  }

  /** Consecutive days with at least one attempt, ending today (or yesterday, if today has none yet). */
  streak(now = new Date()): number {
    const days = new Set(
      this.data.attempts.map((a) => {
        const d = new Date(a.ts);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      }),
    );
    const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!days.has(key(day))) day.setDate(day.getDate() - 1);
    let n = 0;
    while (days.has(key(day))) {
      n++;
      day.setDate(day.getDate() - 1);
    }
    return n;
  }

  addMisconception(conceptId: number | null, text: string, source = ""): number {
    const cleaned = text.trim();
    const existing = this.data.misconceptions.find((m) =>
      !m.resolved && m.concept_id === conceptId && m.text.toLowerCase() === cleaned.toLowerCase(),
    );
    if (existing) return existing.id;
    const id = this.data.nextId++;
    this.data.misconceptions.push({ id, concept_id: conceptId, text: cleaned, resolved: false, ts: new Date().toISOString(), source: source.trim() || undefined });
    this.changed();
    return id;
  }

  openMisconceptions(): Misconception[] {
    return this.data.misconceptions.filter((m) => !m.resolved).reverse();
  }

  resolveMisconception(id: number) {
    const m = this.data.misconceptions.find((x) => x.id === id);
    if (m) {
      m.resolved = true;
      this.changed();
    }
  }

  /** Undo a resolve. */
  reopenMisconception(id: number) {
    const m = this.data.misconceptions.find((x) => x.id === id);
    if (m?.resolved) {
      m.resolved = false;
      this.changed();
    }
  }
}
