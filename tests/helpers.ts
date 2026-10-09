import { vi } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { Backend } from "../src/backend";
import { Library } from "../src/library";
import { Progress, emptyProgress } from "../src/core/progress";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { ExtractedConcept, Note, Question } from "../src/core/types";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const extracted = (name = "Shared idea"): ExtractedConcept => ({ name, summary: "Summary", excerpt: "Excerpt", prerequisites: [], questions: ["Why?"] });
export const question = (id: number): Question => ({
  concept_id: id, misconception_id: null, concept: "Shared idea", kind: "mcq", question: "Which answer is right?",
  options: ["Right", "Wrong", "Other", "Neither"], correct_option: 0, answer: "Right", explanation: "Because it is right.",
});
export function note(path: string, body = `Content from ${path}`): Note {
  return { key: path, path, title: path, body, hash: `hash:${path}`, links: [], kind: "markdown", group: null, pages: null };
}
export function file(path: string): TFile {
  return Object.assign(new TFile(), { path, name: path.split("/").at(-1)!, basename: path.split("/").at(-1)!.replace(/\.md$/, "") });
}
export function folder(path: string): TFolder {
  return Object.assign(new TFolder(), { path, name: path.split("/").at(-1)! });
}

export function fixture(paths = ["a.md", "b.md"]) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.studyFolders = ["/"];
  const disk = new Map<string, string>();
  const files = paths.map(file);
  const events = new Map<string, (...args: unknown[]) => unknown>();
  let layoutReady: (() => Promise<void>) | undefined;
  const adapter = {
    exists: vi.fn(async (path: string) => disk.has(path)),
    read: vi.fn(async (path: string) => disk.get(path)!),
    copy: vi.fn(async (from: string, to: string) => { disk.set(to, disk.get(from)!); }),
    write: vi.fn(async (path: string, data: string) => { await Promise.resolve(); disk.set(path, data); }),
    rename: vi.fn(async (from: string, to: string) => {
      await Promise.resolve();
      if (!disk.has(from)) throw new Error("Temporary file missing");
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    }),
    remove: vi.fn(async (path: string) => { disk.delete(path); }),
  };
  const vault = {
    adapter, configDir: ".obsidian", getName: () => "Test vault", getFiles: () => files,
    getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
    cachedRead: vi.fn(async (f: TFile) => `# ${f.basename}\nContent from ${f.path}`),
    on: (event: string, fn: (...args: unknown[]) => unknown) => { events.set(event, fn); return { event }; },
  };
  const workspace = {
    on: () => ({}),
    onLayoutReady: (fn: () => Promise<void>) => { layoutReady = fn; },
  };
  const app = { vault, workspace } as unknown as App;
  const progress = new Progress(emptyProgress());
  const library = new Library(app, () => settings, "cache");
  for (const path of paths) library.notes.set(path, note(path));
  const backend = new Backend(app, library, progress, () => settings, "/tmp", () => {}, async () => {});
  return { settings, disk, files, events, adapter, vault, app, progress, library, backend, layout: () => layoutReady?.() };
}

export const manifest = { id: "claude-tutor", name: "Claude Tutor", version: "0.1.0", minAppVersion: "1.0.0", description: "Tutor", author: "Test", dir: ".obsidian/plugins/claude-tutor" };
