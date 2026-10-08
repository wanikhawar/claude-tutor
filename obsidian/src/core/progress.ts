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

export class Progress {
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
    this.data.concepts = this.data.concepts.filter((c) => c.note_path !== notePath || keep.has(c.name));
    this.data.notes[notePath] = { hash, indexed_at: new Date().toISOString(), v: EXTRACT_VERSION };
    this.changed();
  }

  conceptsFor(keys: Set<string>): Concept[] {
    return this.data.concepts.filter((c) => keys.has(c.note_path));
  }

  concept(id: number): Concept | undefined {
    return this.data.concepts.find((c) => c.id === id);
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

  attemptsToday(): number {
    const since = Date.now() - 86_400_000;
    return this.data.attempts.filter((a) => new Date(a.ts).getTime() >= since).length;
  }

  addMisconception(conceptId: number | null, text: string): number {
    const cleaned = text.trim();
    const existing = this.data.misconceptions.find((m) =>
      !m.resolved && m.concept_id === conceptId && m.text.toLowerCase() === cleaned.toLowerCase(),
    );
    if (existing) return existing.id;
    const id = this.data.nextId++;
    this.data.misconceptions.push({ id, concept_id: conceptId, text: cleaned, resolved: false, ts: new Date().toISOString() });
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
}
