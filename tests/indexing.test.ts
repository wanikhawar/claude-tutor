import { afterEach, describe, expect, it, vi } from "vitest";
import * as tutor from "../src/core/tutor";
import { Store } from "../src/ui/lib/store.svelte";
import { deferred, extracted, fixture, note } from "./helpers";

let state: Store;
afterEach(() => {
  state?.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(paths?: string[]) {
  const f = fixture(paths);
  state = new Store();
  state.init(
    f.backend,
    () => f.settings,
    async () => {},
  );
  await state.refresh();
  return f;
}

/** What the vault's rename event does: progress and listeners first, then the note is read again. */
function rename(f: ReturnType<typeof fixture>, from: string, to: string) {
  const file = f.files.find((x) => x.path === from)!;
  file.path = to;
  f.backend.renamed(from, to);
  f.library.removeFile(from);
  void f.library.loadFile(file);
}

describe("requested note reads", () => {
  it("waits for bulk reading, then reads a stale note omitted from auto-indexing", async () => {
    const f = await setup();
    f.settings.autoIndex = false;
    f.progress.saveConcepts("b.md", "old-hash", [extracted("Old idea")]);
    await state.refresh();
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi
      .spyOn(tutor, "extractConcepts")
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
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ concepts: [extracted("B idea")] });
    const bulk = state.readSelected(["a.md", "b.md"]);
    const study = state.studyNote(["b.md"], "explain");
    first.resolve({ concepts: [extracted("A idea")] });
    await Promise.all([bulk, study]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.plan?.steps).toEqual([
      { kind: "explain", conceptId: f.progress.data.concepts.find((c) => c.note_path === "b.md")!.id },
    ]);
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
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
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
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockImplementationOnce(() => {
        started.resolve();
        return extractedOld.promise;
      })
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
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
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
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockRejectedValueOnce(new Error("Temporary failure"))
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
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockRejectedValueOnce(new Error("First failure"))
      .mockRejectedValueOnce(new Error("Second failure"))
      .mockResolvedValue({ concepts: [extracted()] });
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

  it("asks again for a later batch after you approved an earlier one", async () => {
    const f = await setup(["a.md", "b.md", "c.md"]);
    f.settings.confirmAbove = 1;
    for (const key of ["a.md", "b.md"]) f.progress.saveConcepts(key, "old-hash", [extracted()]);
    await state.refresh();
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.indexAll();
    state.confirmBulk(true);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.indexing).toBeNull());
    for (const key of ["a.md", "b.md"]) f.library.notes.get(key)!.hash = "edited";
    await state.refresh();
    await state.indexAll();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.confirmCount).toBe(2);
  });

  it("asks about more edits that arrive while an approved batch is being read", async () => {
    const f = await setup(["a.md", "b.md", "c.md", "d.md"]);
    f.settings.confirmAbove = 1;
    for (const key of ["a.md", "b.md", "c.md", "d.md"]) f.progress.saveConcepts(key, "old-hash", [extracted()]);
    for (const key of ["c.md", "d.md"]) f.library.notes.set(key, { ...f.library.notes.get(key)!, hash: "old-hash" });
    await state.refresh();
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async (_, title) => {
      // A sync edits two more notes while the first approved one is read.
      if (title === "a.md")
        for (const key of ["c.md", "d.md"]) f.library.notes.set(key, { ...f.library.notes.get(key)!, hash: "synced" });
      return { concepts: [extracted()] };
    });
    await state.indexAll();
    expect(state.confirmCount).toBe(2);
    state.confirmBulk(true);
    await vi.waitFor(() => expect(state.indexing).toBeNull());
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md", "b.md"]);
    expect(state.confirmCount).toBe(2);
  });

  it("reads a note edited during its read once per pass, leaving the edit for the next pass", async () => {
    const f = await setup(["a.md"]);
    let reads = 0;
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async () => {
      // You keep typing: every read finishes on a note that has changed again.
      f.library.notes.set("a.md", { ...f.library.notes.get("a.md")!, hash: `edit-${++reads}` });
      return { concepts: [extracted()] };
    });
    await state.readSelected(["a.md"]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.note("a.md")?.stale).toBe(true);
    expect(state.indexing).toBeNull();
  });

  it("forgets a pick once it's read, so later edits wait for auto re-reading", async () => {
    const f = await setup(["a.md", "b.md"]);
    f.settings.autoIndex = false;
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.readSelected(["b.md"]);
    expect(extract).toHaveBeenCalledTimes(1);
    f.library.notes.get("b.md")!.hash = "edited";
    await state.refresh();
    await state.indexAll();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.note("b.md")?.stale).toBe(true);
  });

  it("asks before re-reading many edited notes, even ones picked earlier", async () => {
    const f = await setup(["a.md", "b.md", "c.md"]);
    f.settings.confirmAbove = 1;
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.readSelected(["a.md", "b.md"]);
    expect(extract).toHaveBeenCalledTimes(2);
    for (const key of ["a.md", "b.md"]) f.library.notes.get(key)!.hash = "edited";
    await state.refresh();
    await state.indexAll();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.confirmCount).toBe(2);
  });

  it("leaves notes you said Not now to alone, even once fewer are left than it asks about", async () => {
    const f = await setup(["a.md", "b.md", "c.md", "d.md"]);
    f.settings.confirmAbove = 2;
    for (const key of ["a.md", "b.md", "c.md"]) f.progress.saveConcepts(key, "old-hash", [extracted()]);
    await state.refresh();
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    await state.indexAll();
    expect(state.confirmCount).toBe(3);
    state.confirmBulk(false);
    // You re-read one yourself: two are left, few enough not to ask about, but you said no.
    expect(await state.indexOne("a.md")).toBe(true);
    await state.indexAll();
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md"]);
    expect(state.confirmCount).toBeNull();
    // A note edited later is a new question, counted on its own.
    await state.readSelected(["d.md"]);
    f.library.notes.get("d.md")!.hash = "edited";
    await state.refresh();
    await state.indexAll();
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md", "d.md", "d.md"]);
    expect(state.note("b.md")?.stale).toBe(true);
    expect(state.note("c.md")?.stale).toBe(true);
  });

  it("reads a picked note renamed while another is being read, under its new name", async () => {
    const f = await setup(["a.md", "b.md"]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async (_, title) => {
      if (title === "a.md") {
        // What the vault's rename event does: progress and listeners first, then the library.
        f.files.find((x) => x.path === "b.md")!.path = "moved/b.md";
        f.backend.renamed("b.md", "moved/b.md");
        f.library.notes.delete("b.md");
        f.library.notes.set("moved/b.md", note("moved/b.md", "Content from b.md"));
      }
      return { concepts: [extracted()] };
    });
    await state.readSelected(["a.md", "b.md"]);
    expect(extract.mock.calls.map(([, title]) => title)).toEqual(["a.md", "moved/b.md"]);
    expect(state.indexError).toBeNull();
    expect(state.note("moved/b.md")?.stale).toBe(false);
  });

  it("starts a quiz on a note renamed while it waited for another read", async () => {
    const f = await setup(["a.md", "b.md"]);
    const first = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ concepts: [extracted("B idea")] });
    const bulk = state.readSelected(["a.md"]);
    const study = state.studyNote(["b.md"], "quiz");
    await Promise.resolve();
    rename(f, "b.md", "moved/b.md");
    first.resolve({ concepts: [extracted("A idea")] });
    await Promise.all([bulk, study]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.error).toBeNull();
    expect(state.plan?.title).toBe("Quiz: b");
    const ids = state.plan?.steps[0].kind === "quiz" ? state.plan.steps[0].conceptIds : [];
    expect(ids.map((id) => f.progress.concept(id)?.note_path)).toEqual(["moved/b.md"]);
  });

  it("reads a note again under its new name when it's renamed during the read", async () => {
    const f = await setup(["a.md", "b.md"]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async () => {
      if (extract.mock.calls.length === 1) rename(f, "b.md", "moved/b.md");
      return { concepts: [extracted()] };
    });
    await state.studyNote(["b.md"], "explain");
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.error).toBeNull();
    expect(state.note("moved/b.md")?.stale).toBe(false);
    expect(state.plan).not.toBeNull();
  });

  it("reads a note under its new name when it's renamed while its file is still being read", async () => {
    const f = await setup(["a.md", "b.md"]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted()] });
    const raw = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(raw.promise);
    const loading = f.library.loadFile(f.files[1]);
    const study = state.studyNote(["b.md"], "quiz");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(extract).not.toHaveBeenCalled();
    rename(f, "b.md", "moved/b.md");
    raw.resolve("# b\nStale content");
    await loading;
    await study;
    expect(state.error).toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][2]).toContain("Content from moved/b.md");
    expect(state.plan?.title).toBe("Quiz: b");
  });

  it("keeps a pick whose read failed, and reads it on the next pass", async () => {
    const f = await setup(["a.md", "b.md"]);
    f.settings.autoIndex = false;
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockRejectedValueOnce(new Error("Claude is busy"))
      .mockResolvedValue({ concepts: [extracted()] });
    await state.readSelected(["b.md"]);
    expect(state.indexError).toBe("Claude is busy");
    await state.indexAll();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(state.note("b.md")?.stale).toBe(false);
  });
});

describe("study command ordering", () => {
  it("keeps a newer note session when an older command finishes reading", async () => {
    const f = await setup();
    f.progress.saveConcepts("b.md", "hash:b.md", [extracted("Already read")]);
    const pending = deferred<{ concepts: ReturnType<typeof extracted>[] }>();
    const started = deferred<void>();
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
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
    vi.spyOn(tutor, "extractConcepts").mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
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
    state.init(
      f.backend,
      () => f.settings,
      async () => {},
    );
    await state.refresh();
    first.resolve({ concepts: [extracted()] });
    await Promise.all([bulk, study]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.plan).toBeNull();
    expect(state.indexError).toBeNull();
  });
});

describe("reading a long note", () => {
  it("reads it a section at a time, telling each part what earlier parts gave", async () => {
    const f = await setup(["a.md"]);
    const sections = ["## One\n", "## Two\n", "## Three\n"].map((h) => h + "x".repeat(20_000) + "\n");
    f.library.notes.get("a.md")!.body = sections.join("");
    const extract = vi
      .spyOn(tutor, "extractConcepts")
      .mockResolvedValueOnce({ concepts: [extracted("First idea")] })
      .mockResolvedValueOnce({ concepts: [extracted("first idea"), extracted("Second idea")] })
      .mockResolvedValueOnce({ concepts: [extracted("Third idea")] });
    await f.backend.indexNote("a.md");
    expect(extract.mock.calls.map(([, , text]) => text)).toEqual(sections);
    expect(extract.mock.calls.map(([, , , , part]) => part)).toEqual([
      { index: 1, count: 3, earlier: [] },
      { index: 2, count: 3, earlier: ["First idea"] },
      { index: 3, count: 3, earlier: ["First idea", "Second idea"] },
    ]);
    expect(f.progress.data.concepts.map((c) => c.name)).toEqual(["First idea", "Second idea", "Third idea"]);
  });

  it("names this note's own concepts apart from the library's, so a re-read can keep them", async () => {
    const f = await setup(["a.md", "b.md"]);
    f.progress.saveConcepts("a.md", "old-hash", [extracted("Own idea")]);
    f.progress.saveConcepts("b.md", "hash:b.md", [extracted("Other idea")]);
    const extract = vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted("Own idea")] });
    await f.backend.indexNote("a.md");
    const [, , , known, , current] = extract.mock.calls[0];
    expect(known).toEqual(["Other idea"]);
    expect(current).toEqual(["Own idea"]);
  });

  it.each([
    ["its source is removed", (f: ReturnType<typeof fixture>) => (f.settings.studyFolders = [])],
    ["its folder is excluded", (f: ReturnType<typeof fixture>) => (f.settings.excludedFolders = ["notes"])],
    ["it's deleted", (f: ReturnType<typeof fixture>) => f.files.splice(0)],
  ])("sends no more of it once %s", async (_, revoke) => {
    const f = await setup(["notes/a.md"]);
    f.library.notes.get("notes/a.md")!.body = "x".repeat(50_000);
    const extract = vi.spyOn(tutor, "extractConcepts").mockImplementation(async () => {
      revoke(f);
      return { concepts: [extracted()] };
    });
    await state.readSelected(["notes/a.md"]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(f.progress.noteHash("notes/a.md")).toBeUndefined();
    expect(state.indexError).toBeNull();
  });
});
