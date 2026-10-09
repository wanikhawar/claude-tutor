import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeTutorPlugin from "../src/main";
import { store } from "../src/ui/lib/store.svelte";
import * as tutor from "../src/core/tutor";
import { applyExclusions } from "../src/settings";
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
    await f.plugin.onunload();
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
    await f.plugin.onunload();
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
    const unloading = f.plugin.onunload();
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
    void f.plugin.onunload();
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

  it("asks before reading past the bulk limit when the startup scan adds notes mid-run", async () => {
    vi.useFakeTimers();
    const f = pluginFixture(["a.md", "slow.md", "c.md", "d.md"]);
    f.settings.confirmAbove = 2;
    vi.spyOn(f.plugin, "loadData").mockResolvedValue(f.settings);
    const raw = deferred<string>();
    const slowStarted = deferred<void>();
    f.vault.cachedRead.mockImplementation(async (file: TFile) => {
      if (file.path === "slow.md") { slowStarted.resolve(); return raw.promise; }
      return `Content of ${file.path}`;
    });
    const firstExtract = deferred<{ concepts: [] }>();
    const extractStarted = deferred<void>();
    const extract = vi.spyOn(tutor, "extractConcepts")
      .mockImplementationOnce(() => { extractStarted.resolve(); return firstExtract.promise; })
      .mockResolvedValue({ concepts: [] });
    await f.plugin.onload();
    const scanning = f.layout();
    await slowStarted.promise;
    // A note created during the scan starts a run with it and a.md (already scanned): within the limit.
    const created = file("new-during-scan.md");
    f.files.push(created);
    f.events.get("create")!(created);
    await vi.advanceTimersByTimeAsync(2001);
    await extractStarted.promise;
    const indexing = (store as unknown as { indexTask: Promise<unknown> }).indexTask;
    raw.resolve("Slow document contents");
    await scanning;
    firstExtract.resolve({ concepts: [] });
    await indexing;
    // slow.md, c.md and d.md then join the queue, which would make 5 reads: ask instead.
    expect(extract).toHaveBeenCalledTimes(2);
    expect(store.confirmCount).toBe(3);
    await f.plugin.onunload();
  });

  it("does not register vault work if layout becomes ready after unload", async () => {
    const f = pluginFixture();
    await f.plugin.onload();
    await f.plugin.onunload();
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
    const bulk = store.indexAll();
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
    await f.plugin.onunload();
    expect(extract.mock.calls[0][0].signal?.aborted).toBe(true);
    pending.resolve({ concepts: [extracted()] });
    await bulk;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(f.plugin.backend.progress.data.concepts).toEqual([]);
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
