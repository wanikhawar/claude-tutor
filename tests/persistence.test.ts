import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeTutorPlugin from "../src/main";
import { store } from "../src/ui/lib/store.svelte";
import * as tutor from "../src/core/tutor";
import * as providers from "../src/core/providers";
import { review } from "../src/core/srs";
import { applyExclusions } from "../src/settings";
import { emptyProgress, type ProgressData } from "../src/core/progress";
import { fixture, file, folder, extracted, deferred, manifest } from "./helpers";
import { FileSystemAdapter, type TFile } from "obsidian";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROGRESS = ".obsidian/plugins/claude-tutor/progress.json";
function pendingSaves() {
  const g = globalThis as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (g[Symbol.for("claude-tutor.pending-progress-saves")] ??= new Map());
}
async function microtasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const tempDirs: string[] = [];
afterEach(async () => {
  pendingSaves().clear();
  store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pluginFixture(paths?: string[]) {
  const f = fixture(paths);
  const plugin = new ClaudeTutorPlugin(f.app, manifest);
  plugin.backend = f.backend;
  plugin.settings = f.settings;
  const internals = plugin as unknown as {
    progressFile: string;
    saveProgress(): Promise<void>;
    loadProgress(): Promise<ProgressData>;
    registerVaultEvents(): void;
    withNote(file: TFile, then: (keys: string[], request: number) => void): Promise<void>;
  };
  internals.progressFile = "progress.json";
  return { ...f, plugin, internals };
}

async function filesystemFixture() {
  const f = pluginFixture();
  const dir = await mkdtemp(join(tmpdir(), "claude-tutor-save-"));
  tempDirs.push(dir);
  const adapter = Object.assign(new FileSystemAdapter(), f.adapter, {
    getFullPath: vi.fn((path: string) => join(dir, path)),
    write: vi.fn((path: string, data: string) => writeFile(join(dir, path), data)),
    // The real Obsidian adapter refuses to overwrite a destination.
    rename: vi.fn(async () => { throw new Error("Destination file already exists!"); }),
  });
  f.vault.adapter = adapter;
  return { ...f, adapter, dir };
}

describe("progress persistence", () => {
  it.each([
    ['{"concepts":null}'],
    ['{"concepts":[null]}'],
    ['{"notes":{"a.md":null}}'],
    ['{"misconceptions":[{"id":1,"text":null}]}'],
    ['{"nextId":"7"}'],
    ['[]'],
  ])("starts fresh from a file of the wrong shape (%s) and keeps a backup", async (text) => {
    const f = pluginFixture();
    f.disk.set("progress.json", text);
    expect(await f.internals.loadProgress()).toEqual(emptyProgress());
    expect(f.disk.get("progress.json.bak")).toBe(text);
  });

  it("never copies over an older backup", async () => {
    const f = pluginFixture();
    f.disk.set("progress.json", "{broken");
    f.disk.set("progress.json.bak", "older backup");
    await f.internals.loadProgress();
    expect(f.disk.get("progress.json.bak")).toBe("older backup");
    expect(f.disk.get("progress.json.bak2")).toBe("{broken");
  });

  it("doesn't write over a file it couldn't read or back up", async () => {
    const f = pluginFixture();
    f.disk.set("progress.json", "{broken");
    f.adapter.copy.mockRejectedValueOnce(new Error("Disk full"));
    await f.internals.loadProgress();
    await f.internals.saveProgress();
    expect(f.disk.get("progress.json")).toBe("{broken");
  });

  it("gives every field studying reads its default when it's missing or the wrong type", async () => {
    const f = pluginFixture();
    f.disk.set("progress.json", JSON.stringify({
      nextId: 5,
      notes: { "a.md": { hash: "h", v: "2", indexed_at: null } },
      concepts: [{ id: 1, note_path: "a.md", name: "Idea", summary: null, prerequisites: null, excerpt: 5, questions: "Why?", ease: "2.5",
        interval_days: null, reps: null, due: 0, mastery: "high", last_reviewed: {}, extra: "kept" }],
      attempts: [{ ts: "2026-10-10T09:00:00Z", score: "x", concept_id: "1" }, { score: 1 }],
      misconceptions: [{ id: 3, text: "Oops", concept_id: "1", resolved: "yes", ts: null }],
    }));
    const data = await f.internals.loadProgress();
    expect(data.concepts).toEqual([{ id: 1, note_path: "a.md", name: "Idea", summary: "", prerequisites: [], excerpt: "", questions: [], ease: 2.5,
      interval_days: 0, reps: 0, lapses: 0, due: null, mastery: 0, last_reviewed: null, extra: "kept" }]);
    expect(data.notes["a.md"]).toMatchObject({ hash: "h", indexed_at: "", v: undefined });
    expect(data.attempts).toEqual([{ concept_id: null, kind: "", score: 0, ts: "2026-10-10T09:00:00Z" }]);
    expect(data.misconceptions).toEqual([{ id: 3, text: "Oops", concept_id: null, resolved: false, ts: "", source: undefined }]);
    // And the concept can be studied and scheduled.
    const ask = vi.spyOn(providers, "ask").mockResolvedValue({});
    const concept = data.concepts[0];
    await tutor.evaluateFeynman({ path: "", model: "", cwd: "/tmp" }, { concept, question: "Why?", noteTitle: "A", noteBody: "", attempt: 0, explanation: "Because", previousGaps: [], peeked: false, stuck: false });
    expect(ask).toHaveBeenCalled();
    review(concept, 0.8);
    expect(concept.reps).toBe(1);
    expect(concept.due).toMatch(/^\d{4}-/);
  });

  it("keeps new ids clear of saved ones when nextId is missing", async () => {
    const f = pluginFixture();
    const concept = { id: 7, note_path: "a.md", name: "Idea", summary: "", prerequisites: [], excerpt: "", questions: [], ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due: null, mastery: 0, last_reviewed: null };
    f.disk.set("progress.json", JSON.stringify({ concepts: [concept], misconceptions: [{ id: 9, concept_id: 7, text: "x", resolved: false, ts: "" }] }));
    const data = await f.internals.loadProgress();
    expect(data.concepts).toEqual([concept]);
    expect(data.nextId).toBe(10);
  });

  it("atomically replaces an existing desktop save and serializes newer snapshots", async () => {
    const f = await filesystemFixture();
    const destination = join(f.dir, "progress.json");
    await writeFile(destination, "last good progress");
    const first = f.internals.saveProgress();
    f.progress.data.nextId = 42;
    const second = f.internals.saveProgress();
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(destination, "utf8")).nextId).toBe(42);
    await expect(stat(`${destination}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.adapter.rename).not.toHaveBeenCalled();
    expect(f.adapter.remove).not.toHaveBeenCalled();
  });

  it("preserves the existing desktop save after a filesystem rename failure and retries", async () => {
    const f = await filesystemFixture();
    const destination = join(f.dir, "progress.json");
    await writeFile(destination, "last good progress");
    f.adapter.getFullPath.mockReturnValueOnce(join(f.dir, "missing.tmp"));
    await expect(f.internals.saveProgress()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(destination, "utf8")).toBe("last good progress");
    f.progress.data.nextId = 10;
    await f.internals.saveProgress();
    expect(JSON.parse(await readFile(destination, "utf8")).nextId).toBe(10);
    expect(f.adapter.remove).not.toHaveBeenCalled();
  });

  it("serializes simultaneous first saves and keeps the newest snapshot", async () => {
    const f = pluginFixture();
    const first = f.internals.saveProgress();
    f.progress.data.nextId = 42;
    const second = f.internals.saveProgress();
    await Promise.all([first, second]);
    expect(JSON.parse(f.disk.get("progress.json")!).nextId).toBe(42);
    expect(f.adapter.rename).toHaveBeenCalledTimes(2);
    expect(f.adapter.remove).not.toHaveBeenCalled();
  });

  it("keeps the last good file after a rename failure and allows a later save", async () => {
    const f = pluginFixture();
    f.disk.set("progress.json", "last good progress");
    f.adapter.rename.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(f.internals.saveProgress()).rejects.toThrow("Permission denied");
    expect(f.disk.get("progress.json")).toBe("last good progress");
    expect(f.adapter.remove).not.toHaveBeenCalled();
    f.progress.data.nextId = 10;
    await f.internals.saveProgress();
    expect(JSON.parse(f.disk.get("progress.json")!).nextId).toBe(10);
  });

  it("cancels debounced saves and vault reloads when unloading", async () => {
    vi.useFakeTimers();
    const f = pluginFixture();
    vi.spyOn(f.plugin, "loadData").mockResolvedValue(f.settings);
    await f.plugin.onload();
    await f.layout();
    await Promise.resolve();
    f.events.get("modify")!(f.files[0]);
    f.plugin.backend.progress.touch();
    f.plugin.onunload();
    await f.plugin.unloading;
    const reads = f.vault.cachedRead.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.vault.cachedRead).toHaveBeenCalledTimes(reads);
    expect(f.adapter.rename).toHaveBeenCalledTimes(1);
    expect(f.disk.has(".obsidian/plugins/claude-tutor/progress.json")).toBe(true);
  });

  it("waits for the previous instance's unload save before reading progress", async () => {
    const prior = deferred<void>();
    pendingSaves().set(PROGRESS, prior.promise);
    const f = pluginFixture();
    f.disk.set(PROGRESS, JSON.stringify({ nextId: 1 }));
    const loading = f.plugin.onload();
    await microtasks();
    expect(f.adapter.read).not.toHaveBeenCalled();
    f.disk.set(PROGRESS, JSON.stringify({ nextId: 7 }));
    prior.resolve();
    await loading;
    expect(f.plugin.backend.progress.data.nextId).toBe(7);
    f.plugin.onunload();
    await f.plugin.unloading;
  });

  it("starts nothing if disabled while waiting for a prior unload save", async () => {
    const prior = deferred<void>();
    pendingSaves().set(PROGRESS, prior.promise);
    const f = pluginFixture();
    (f.plugin as unknown as { backend?: unknown }).backend = undefined;
    f.disk.set(PROGRESS, JSON.stringify({ nextId: 1 }));
    const ribbon = vi.spyOn(f.plugin, "addRibbonIcon");
    const loading = f.plugin.onload();
    await microtasks();
    f.plugin.onunload();
    const unloading = f.plugin.unloading;
    prior.resolve();
    await Promise.all([loading, unloading]);
    expect(ribbon).not.toHaveBeenCalled();
    expect(f.plugin.backend).toBeUndefined();
    expect(f.adapter.read).not.toHaveBeenCalled();
  });

  it("keeps waiting on a pending save when a replacement is unloaded before it finished loading", async () => {
    const prior = deferred<void>();
    pendingSaves().set(PROGRESS, prior.promise);
    const f = pluginFixture();
    (f.plugin as unknown as { backend?: unknown }).backend = undefined;
    const loading = f.plugin.onload();
    await microtasks();
    f.plugin.onunload();
    const chained = pendingSaves().get(PROGRESS);
    let settled = false;
    void chained?.then(() => (settled = true));
    await microtasks();
    expect(chained).toBeDefined();
    expect(settled).toBe(false);
    prior.resolve();
    await loading;
    await chained;
    expect(settled).toBe(true);
  });

  it("never sends new notes to Claude when the startup scan or an edit finds them", async () => {
    vi.useFakeTimers();
    const f = pluginFixture(["a.md", "b.md"]);
    vi.spyOn(f.plugin, "loadData").mockResolvedValue(f.settings);
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [] });
    await f.plugin.onload();
    await f.layout();
    const created = file("new.md");
    f.files.push(created);
    f.events.get("create")!(created);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(extract).not.toHaveBeenCalled();
    expect(store.unread.map((n) => n.key)).toEqual(["a.md", "b.md", "new.md"]);
    f.plugin.onunload();
    await f.plugin.unloading;
  });

  it("does not register vault work if layout becomes ready after unload", async () => {
    const f = pluginFixture();
    await f.plugin.onload();
    f.plugin.onunload();
    await f.plugin.unloading;
    await f.layout();
    expect(f.vault.cachedRead).not.toHaveBeenCalled();
    expect(f.events.size).toBe(0);
  });

  it("unloading during a bulk read cancels its request and never starts the remaining note", async () => {
    vi.useFakeTimers();
    const f = pluginFixture();
    vi.spyOn(f.plugin, "loadData").mockResolvedValue(f.settings);
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi.spyOn(tutor, "extractConcepts").mockReturnValue(pending.promise);
    await f.plugin.onload();
    await f.layout();
    await store.refresh();
    const bulk = store.readSelected(["a.md", "b.md"]);
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
    f.plugin.onunload();
    await f.plugin.unloading;
    expect(extract.mock.calls[0][0].signal?.aborted).toBe(true);
    pending.resolve({ concepts: [extracted()] });
    await bulk;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(f.plugin.backend.progress.data.concepts).toEqual([]);
  });
});

describe("where the tutor lives", () => {
  function leaf(root: object) {
    return { getRoot: () => root, detach: vi.fn(), setViewState: vi.fn(async () => {}) };
  }

  it("moves a tutor tab restored from an older layout into the right sidebar", async () => {
    const f = pluginFixture();
    const rightSplit = {};
    const tab = leaf({});
    const side = leaf(rightSplit);
    Object.assign(f.app.workspace, { rightSplit, getLeavesOfType: () => [tab], getRightLeaf: () => side });
    f.settings.openInSidebar = true;
    await f.plugin.placeView();
    expect(tab.detach).toHaveBeenCalled();
    expect(side.setViewState).toHaveBeenCalledWith({ type: "claude-tutor", active: false });
  });

  it("leaves a view that's already in the sidebar alone", async () => {
    const f = pluginFixture();
    const rightSplit = {};
    const side = leaf(rightSplit);
    Object.assign(f.app.workspace, { rightSplit, getLeavesOfType: () => [side] });
    f.settings.openInSidebar = true;
    expect(await f.plugin.placeView()).toBe(side);
    expect(side.detach).not.toHaveBeenCalled();
  });
});

describe("note command ordering", () => {
  it("does not activate or launch an older command that finishes loading after a newer one", async () => {
    const f = pluginFixture();
    store.init(f.backend, () => f.settings, async () => {});
    await store.refresh();
    const old = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(old.promise).mockResolvedValueOnce("# New choice\nContent");
    const activate = vi.spyOn(f.plugin, "activate").mockResolvedValue();
    const launch = vi.fn();
    const older = f.internals.withNote(f.files[0], launch);
    await f.internals.withNote(f.files[1], launch);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toEqual(["b.md"]);
    old.resolve("# Old choice\nContent");
    await older;
    expect(activate).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not launch a pending note command after the learner selects another session", async () => {
    const f = pluginFixture();
    f.progress.saveConcepts("b.md", "hash:b.md", [extracted("Selected idea")]);
    store.init(f.backend, () => f.settings, async () => {});
    await store.refresh();
    const old = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(old.promise);
    const activate = vi.spyOn(f.plugin, "activate").mockResolvedValue();
    const launch = vi.fn();
    const older = f.internals.withNote(f.files[0], launch);
    store.startExplain(store.concepts[0].id);
    const selected = store.plan;
    old.resolve("Old choice content");
    await older;
    expect(activate).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(store.plan).toBe(selected);
  });
});

describe("vault folder renames", () => {
  it("moves sources, exclusions, descendant progress and notes before reloading", async () => {
    const f = pluginFixture(["old/one.md", "old/sub/two.md", "old/private/secret.md", "older/keep.md"]);
    f.settings.studyFolders = ["old", "old/sub", "older"];
    f.settings.studyFiles = ["old/one.md", "old/sub/two.md"];
    f.settings.excludedFolders = ["old/private"];
    f.progress.saveConcepts("old/one.md", "hash", [extracted()]);
    const id = f.progress.data.concepts[0].id;
    f.internals.registerVaultEvents();
    f.files.splice(0, 3, file("new/one.md"), file("new/sub/two.md"), file("new/private/secret.md"));
    const renamed = f.events.get("rename")!(folder("new"), "old");
    expect(f.settings.studyFolders).toEqual(["new", "new/sub", "older"]);
    expect(f.settings.studyFiles).toEqual(["new/one.md", "new/sub/two.md"]);
    expect(f.settings.excludedFolders).toEqual(["new/private"]);
    await renamed;
    expect(f.library.notes.has("new/one.md")).toBe(true);
    expect(f.library.notes.has("new/sub/two.md")).toBe(true);
    expect(f.library.notes.has("new/private/secret.md")).toBe(false);
    expect(f.library.notes.has("old/one.md")).toBe(false);
    expect(f.library.notes.has("older/keep.md")).toBe(true);
    expect(f.progress.concept(id)?.note_path).toBe("new/one.md");
    await f.events.get("rename")!(f.files[0], "old/one.md");
    expect(f.progress.concept(id)?.note_path).toBe("new/one.md");
    expect(f.vault.cachedRead.mock.calls.some(([n]) => n.path.includes("private"))).toBe(false);
  });

  it("keeps a renamed excluded folder excluded inside a whole-vault source", async () => {
    const f = pluginFixture(["hidden/secret.md"]);
    f.settings.excludedFolders = ["hidden"];
    f.internals.registerVaultEvents();
    f.files[0] = file("moved/secret.md");
    await f.events.get("rename")!(folder("moved"), "hidden");
    expect(f.settings.excludedFolders).toEqual(["moved"]);
    expect(f.library.inScope("moved/secret.md")).toBe(false);
    expect(f.vault.cachedRead).not.toHaveBeenCalled();
  });

  it("does not reintroduce excluded notes when an earlier vault read finishes after the rename", async () => {
    const f = pluginFixture(["moved/secret.md"]);
    f.settings.excludedFolders = ["hidden"];
    const pending = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(pending.promise);
    const read = f.library.loadFile(f.files[0]);
    f.internals.registerVaultEvents();
    await f.events.get("rename")!(folder("moved"), "hidden");
    pending.resolve("Secret note content");
    expect(await read).toEqual([]);
    expect(f.library.notes.has("moved/secret.md")).toBe(false);
  });
});

describe("excluded folders", () => {
  it("keeps a note added inside an excluded folder, but a later exclusion wins", () => {
    const f = fixture(["Notes/a.md", "Notes/Sub/b.md", "Other/c.md"]);
    f.settings.studyFolders = ["/"];
    f.settings.excludedFolders = ["Notes"];
    f.settings.studyFiles = ["Notes/a.md"];
    expect(f.library.inScope("Notes/a.md")).toBe(true);
    expect(f.library.inScope("Notes/Sub/b.md")).toBe(false);

    f.settings.excludedFolders = [];
    f.settings.studyFiles = ["Notes/a.md", "Other/c.md"];
    const before = { excluded: [...f.settings.excludedFolders], files: [...f.settings.studyFiles] };
    // Typing "Notes" passes through "Not"; neither should lose a note for good.
    for (const typed of ["N", "Not", "Notes"]) applyExclusions(f.settings, before.excluded, before.files, [typed]);
    expect(f.settings.studyFiles).toEqual(["Other/c.md"]);
    expect(f.library.inScope("Notes/a.md")).toBe(false);

    applyExclusions(f.settings, before.excluded, before.files, ["Notes/Sub"]);
    expect(f.settings.studyFiles).toEqual(["Notes/a.md", "Other/c.md"]);
  });
});

describe("settings migration", () => {
  it("replaces the old 'CLI default' effort with Medium", async () => {
    const plugin = new ClaudeTutorPlugin(fixture().app, manifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue({ effort: "" });
    await plugin.loadSettings();
    expect(plugin.settings.effort).toBe("medium");
    vi.spyOn(plugin, "loadData").mockResolvedValue({ effort: "high" });
    await plugin.loadSettings();
    expect(plugin.settings.effort).toBe("high");
  });
});
