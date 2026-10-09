import { afterEach, describe, expect, it, vi } from "vitest";
import * as tutor from "../src/core/tutor";
import { Store } from "../src/ui/lib/store.svelte";
import { deferred, extracted, fixture } from "./helpers";

let state: Store;
afterEach(() => { state?.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(paths?: string[]) {
  const f = fixture(paths);
  state = new Store();
  state.init(f.backend, () => f.settings, async () => {});
  await state.refresh();
  return f;
}

describe("requested note reads", () => {
  it("waits for bulk reading, then reads a stale note omitted from auto-indexing", async () => {
    const f = await setup();
    f.settings.autoIndex = false;
    f.progress.saveConcepts("b.md", "old-hash", [extracted("Old idea")]);
    await state.refresh();
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi.spyOn(tutor, "extractConcepts")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ concepts: [extracted("Requested idea")] });
    const bulk = state.readSelected(["a.md"]);
    const study = state.studyNote(["b.md"], "quiz");
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.plan).toBeNull();
    first.resolve({ concepts: [extracted("Background idea")] });
    await Promise.all([bulk, study]);
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md", "b.md"]);
    expect(state.plan?.title).toBe("Quiz: b.md");
    const ids = state.plan?.steps[0].kind === "quiz" ? state.plan.steps[0].conceptIds : [];
    expect(ids.map((id) => f.progress.concept(id)?.name)).toEqual(["Requested idea"]);
  });

  it("awaits a note already in the bulk queue without reading it twice", async () => {
    const f = await setup();
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi.spyOn(tutor, "extractConcepts")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ concepts: [extracted("B idea")] });
    const bulk = state.readSelected(["a.md", "b.md"]);
    const study = state.studyNote(["b.md"], "explain");
    first.resolve({ concepts: [extracted("A idea")] });
    await Promise.all([bulk, study]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.plan?.steps).toEqual([{ kind: "explain", conceptId: f.progress.data.concepts.find((c) => c.note_path === "b.md")!.id }]);
  });

  it("clears a failed attempt's error before a successful single-note retry", async () => {
    await setup();
    vi.spyOn(tutor, "extractConcepts")
      .mockRejectedValueOnce(new Error("Earlier failure"))
      .mockResolvedValueOnce({ concepts: [extracted()] });
    expect(await state.indexOne("b.md")).toBe(false);
    expect(state.indexError).toBe("Earlier failure");
    await state.studyNote(["b.md"], "quiz");
    expect(state.indexError).toBeNull();
    expect(state.error).toBeNull();
    expect(state.plan?.title).toBe("Quiz: b.md");
  });

  it("retries extraction after an edit and starts the session with the current concepts", async () => {
    const f = await setup(["a.md"]);
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const started = deferred<void>();
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementationOnce(() => { started.resolve(); return pending.promise; })
      .mockResolvedValueOnce({ concepts: [extracted("Current idea")] });
    const studying = state.studyNote(["a.md"], "quiz");
    await started.promise;
    expect(extract).toHaveBeenCalledTimes(1);
    f.library.notes.set("a.md", { ...f.library.notes.get("a.md")!, hash: "edited-hash", body: "Edited content" });
    pending.resolve({ concepts: [extracted("Obsolete idea")] });
    await studying;
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1][2]).toBe("Edited content");
    expect(state.notes[0].stale).toBe(false);
    expect(state.concepts.map((c) => c.name)).toEqual(["Current idea"]);
    expect(state.plan?.title).toBe("Quiz: a.md");
  });

  it("awaits a pending vault read before retrying a discarded extraction", async () => {
    const f = await setup(["a.md"]);
    const extractedOld = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const started = deferred<void>();
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementationOnce(() => { started.resolve(); return extractedOld.promise; })
      .mockResolvedValueOnce({ concepts: [extracted("Current idea")] });
    const reading = state.studyNote(["a.md"], "quiz");
    await started.promise;
    const raw = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(raw.promise);
    const loading = f.library.loadFile(f.files[0]);
    extractedOld.resolve({ concepts: [extracted("Obsolete idea")] });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(state.plan).toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
    raw.resolve("# Current\nNewly loaded content");
    await loading;
    await reading;
    expect(state.indexError).toBeNull();
    expect(state.concepts.map((c) => c.name)).toEqual(["Current idea"]);
    expect(state.plan?.title).toBe("Quiz: Current");
  });

  it("waits for a pending vault load when the requested note is temporarily absent from the snapshot", async () => {
    const f = await setup(["a.md"]);
    const raw = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(raw.promise);
    const loading = f.library.loadFile(f.files[0]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    const studying = state.studyNote(["a.md"], "quiz");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(extract).not.toHaveBeenCalled();
    raw.resolve("# Current\nCurrent content");
    await loading;
    await studying;
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.plan?.title).toBe("Quiz: Current");
    expect(state.indexError).toBeNull();
  });

  it("reports a removed note rather than starting a session on its old concepts", async () => {
    const f = await setup(["a.md"]);
    f.progress.saveConcepts("a.md", "old-hash", [extracted("Old idea")]);
    const started = deferred<void>();
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => { started.resolve(); return pending.promise; });
    const studying = state.studyNote(["a.md"], "quiz");
    await started.promise;
    f.files.splice(0);
    f.library.removeFile("a.md");
    pending.resolve({ concepts: [extracted()] });
    await studying;
    expect(state.plan).toBeNull();
    expect(state.error).toContain("no longer in the library");
    await state.retryIndexing();
    expect(state.indexError).toBeNull();
  });

  it("stops retrying a continuously edited note and reports a useful error", async () => {
    const f = await setup(["a.md"]);
    let revision = 0;
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async () => {
      f.library.notes.set("a.md", { ...f.library.notes.get("a.md")!, hash: `revision-${++revision}` });
      return { concepts: [extracted()] };
    });
    await state.studyNote(["a.md"], "quiz");
    expect(extract).toHaveBeenCalledTimes(3);
    expect(state.plan).toBeNull();
    expect(state.indexError).toContain("keeps changing");
    expect(state.error).toBe(state.indexError);
  });

  it("retries a failed manual read with automatic re-reading disabled", async () => {
    const f = await setup(["a.md"]);
    f.settings.autoIndex = false;
    f.progress.saveConcepts("a.md", "old-hash", [extracted()]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ concepts: [extracted()] });
    expect(await state.indexOne("a.md")).toBe(false);
    await state.retryIndexing();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.indexError).toBeNull();
    expect(state.notes[0].stale).toBe(false);
    expect(f.settings.autoIndex).toBe(false);
  });

  it("retains the failed note when retry fails again, and resumes the remaining bulk queue on success", async () => {
    await setup();
    const extract = vi.spyOn(tutor, "extractConcepts").mockRejectedValueOnce(new Error("First failure"))
      .mockRejectedValueOnce(new Error("Second failure")).mockResolvedValue({ concepts: [extracted()] });
    await state.readSelected(["a.md", "b.md"]);
    await state.retryIndexing();
    expect(state.indexError).toBe("Second failure");
    await state.retryIndexing();
    expect(state.notes.every((n) => !n.stale)).toBe(true);
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md", "a.md", "a.md", "b.md"]);
    expect(state.indexError).toBeNull();
  });
});

describe("choosing what Clawd reads", () => {
  it("never reads new notes until you pick them, then reads only those", async () => {
    await setup(["a.md", "b.md", "c.md"]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.indexAll();
    expect(extract).not.toHaveBeenCalled();
    expect(state.confirmCount).toBeNull();
    expect(state.unread.map((n) => n.key)).toEqual(["a.md", "b.md", "c.md"]);
    await state.readSelected(["b.md"]);
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["b.md"]);
    expect(state.unread.map((n) => n.key)).toEqual(["a.md", "c.md"]);
  });

  it("asks before re-reading many edited notes, but not for the ones you picked", async () => {
    const f = await setup(["a.md", "b.md", "c.md"]);
    f.settings.confirmAbove = 1;
    for (const key of ["a.md", "b.md"]) f.progress.saveConcepts(key, "old-hash", [extracted()]);
    await state.refresh();
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.indexAll();
    expect(extract).not.toHaveBeenCalled();
    expect(state.confirmCount).toBe(2);
    await state.readSelected(["c.md"]);
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["c.md"]);
    expect(state.confirmCount).toBe(2);
    state.confirmBulk(true);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(3));
    expect(state.confirmCount).toBeNull();
  });
});

describe("study command ordering", () => {
  it("keeps a newer note session when an older command finishes reading", async () => {
    const f = await setup();
    f.progress.saveConcepts("b.md", "hash:b.md", [extracted("Already read")]);
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const started = deferred<void>();
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => { started.resolve(); return pending.promise; });
    const older = state.studyNote(["a.md"], "quiz");
    await started.promise;
    await state.studyNote(["b.md"], "quiz");
    const newer = state.plan;
    expect(newer?.title).toBe("Quiz: b.md");
    pending.resolve({ concepts: [extracted("Newly read")] });
    await older;
    expect(state.plan).toBe(newer);
  });

  it.each(["start", "end"])("invalidates an older note command when the learner uses %s", async (action) => {
    const f = await setup();
    f.progress.saveConcepts("b.md", "hash:b.md", [extracted("Already read")]);
    await state.refresh();
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const started = deferred<void>();
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => { started.resolve(); return pending.promise; });
    const older = state.studyNote(["a.md"], "quiz");
    await started.promise;
    if (action === "start") state.startExplain(state.concepts[0].id);
    else state.endSession();
    const selected = state.plan;
    pending.resolve({ concepts: [extracted()] });
    await older;
    expect(state.plan).toBe(selected);
  });

  it("ignores a superseded command that finishes loading the vault file later", async () => {
    const f = await setup();
    for (const n of f.library.notes.values()) f.progress.saveConcepts(n.key, n.hash, [extracted()]);
    const older = state.beginStudyRequest();
    const newer = state.beginStudyRequest();
    await state.studyNote(["b.md"], "quiz", newer);
    const selected = state.plan;
    await state.studyNote(["a.md"], "quiz", older);
    expect(state.plan).toBe(selected);
  });

  it("gives successive plans distinct identities even within the same millisecond", async () => {
    const f = await setup();
    f.progress.saveConcepts("a.md", "hash:a.md", [extracted()]);
    await state.refresh();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    state.startExplain(state.concepts[0].id);
    const first = state.plan!.id;
    state.startExplain(state.concepts[0].id);
    expect(state.plan!.id).not.toBe(first);
  });
});

describe("indexing disposal", () => {
  it("aborts the current read, stops the bulk loop and clears timers and subscriptions", async () => {
    vi.useFakeTimers();
    const f = await setup();
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi.spyOn(tutor, "extractConcepts").mockReturnValue(first.promise);
    const bulk = state.readSelected(["a.md", "b.md"]);
    f.backend.emit();
    await Promise.resolve();
    const refresh = vi.spyOn(state, "refresh");
    const signal = extract.mock.calls[0][0].signal!;
    state.dispose();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    first.resolve({ concepts: [extracted()] });
    await bulk;
    f.backend.emit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(f.progress.data.concepts).toEqual([]);
    expect(state.indexing).toBeNull();
    expect(state.indexError).toBeNull();
  });

  it("prevents an old read or waiting command from mutating a reinitialized store", async () => {
    const f = await setup();
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi.spyOn(tutor, "extractConcepts").mockReturnValue(first.promise);
    const bulk = state.readSelected(["a.md", "b.md"]);
    const study = state.studyNote(["b.md"], "quiz");
    await Promise.resolve();
    state.init(f.backend, () => f.settings, async () => {});
    await state.refresh();
    first.resolve({ concepts: [extracted()] });
    await Promise.all([bulk, study]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.plan).toBeNull();
    expect(state.indexError).toBeNull();
  });
});
