import { afterEach, describe, expect, it, vi } from "vitest";
import * as tutor from "../src/core/tutor";
import type { TeachReply } from "../src/core/types";
import { deferred, extracted, file, fixture, note, pdf } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("vault read ordering", () => {
  it("discards a pending read after its note is deleted", async () => {
    const f = fixture(["a.md"]);
    const read = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(read.promise);
    const loading = f.library.loadFile(f.files[0]);
    f.files.splice(0);
    f.library.removeFile("a.md");
    read.resolve("# Deleted note\nThis file was removed");
    expect(await loading).toEqual([]);
    expect(f.library.notes.has("a.md")).toBe(false);
  });

  it("invalidates pending reads of a removed folder's descendants", async () => {
    const f = fixture(["folder/a.md"]);
    const read = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(read.promise);
    const loading = f.library.loadFile(f.files[0]);
    f.library.removeFile("folder");
    read.resolve("Removed descendant content");
    expect(await loading).toEqual([]);
    expect(f.library.notes.size).toBe(0);
  });

  it("keeps the latest content when an older read finishes last", async () => {
    const f = fixture(["a.md"]);
    const older = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(older.promise).mockResolvedValueOnce("# New\nCurrent content");
    const first = f.library.loadFile(f.files[0]);
    await f.library.loadFile(f.files[0]);
    older.resolve("# Old\nObsolete content");
    expect(await first).toEqual([]);
    expect(f.library.notes.get("a.md")?.body).toContain("Current content");
  });

  it("ignores an obsolete read's failure after the newer read succeeds", async () => {
    const f = fixture(["a.md"]);
    const older = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(older.promise).mockResolvedValueOnce("Current content");
    const first = f.library.loadFile(f.files[0]);
    await f.library.loadFile(f.files[0]);
    older.reject(new Error("Old read failed"));
    await first;
    expect(f.library.skipped.size).toBe(0);
    expect(f.library.notes.get("a.md")?.body).toBe("Current content");
  });

  it("keeps a replacement file's content when an old file object is loaded again", async () => {
    const f = fixture(["a.md"]);
    const oldFile = f.files[0];
    f.files[0] = file("a.md");
    f.vault.cachedRead.mockResolvedValue("Replacement file content");
    await f.library.loadFile(f.files[0]);
    expect(await f.library.loadFile(oldFile)).toEqual([]);
    expect(f.library.notes.get("a.md")?.body).toBe("Replacement file content");
  });

  it("stops a superseded rescan before it starts the remaining reads", async () => {
    const f = fixture();
    const older = deferred<string>();
    f.vault.cachedRead.mockReturnValueOnce(older.promise).mockResolvedValue("Latest content");
    const first = f.library.loadAll();
    f.files.splice(0, 1);
    await f.library.loadAll();
    older.resolve("Obsolete content");
    await first;
    expect(f.vault.cachedRead.mock.calls.map(([n]) => n.path)).toEqual(["a.md", "b.md"]);
    expect([...f.library.notes.keys()]).toEqual(["b.md"]);
    expect(f.library.notes.get("b.md")?.body).toBe("Latest content");
  });
});

describe("PDF parts", () => {
  it("keeps progress when a re-read PDF splits into different page ranges", async () => {
    const f = fixture([]);
    const book = pdf(f, "book.pdf", ["First page", "Second page", "Third page"]);
    // Read before as two parts, both picked.
    f.progress.saveConcepts("book.pdf#p1-2", "old", [{ ...extracted("Second"), excerpt: "Second page" }]);
    f.progress.saveConcepts("book.pdf#p3-3", "old", [extracted("Third")]);
    expect(await f.library.loadFile(book)).toEqual(["book.pdf#p1-1", "book.pdf#p2-2", "book.pdf#p3-3"]);
    expect(f.progress.data.concepts.map((c) => c.note_path)).toEqual(["book.pdf#p2-2", "book.pdf#p3-3"]);
    const notes = f.backend.snapshot().notes;
    expect(notes.map((n) => [n.key, n.indexed, n.stale])).toEqual([
      ["book.pdf#p1-1", true, true],
      ["book.pdf#p2-2", true, true],
      ["book.pdf#p3-3", true, true],
    ]);
  });

  it("lets a lesson on a former part go on with the parts that replaced it", async () => {
    const f = fixture(["other.md"]);
    const book = pdf(f, "book.pdf", ["First page", "Second page", "Third page"]);
    for (const k of ["book.pdf#p1-2", "book.pdf#p3-3", "other.md"]) f.progress.saveConcepts(k, "old", [extracted(k)]);
    let sources = ["book.pdf#p1-2", "other.md"];
    f.backend.onRepartition((replace) => (sources = sources.flatMap(replace)));
    await f.library.loadFile(book);
    expect(sources).toEqual(["book.pdf#p1-1", "book.pdf#p2-2", "other.md"]);
    const teach = vi.spyOn(tutor, "teach").mockResolvedValue({} as TeachReply);
    await f.backend.teach("idea", sources, [[false, "Your PDF says…"]], "Go on");
    expect(teach.mock.calls[0][2]).toContain("Second page");
    expect(teach.mock.calls[0][2]).not.toContain("Third page");
  });

  it("keeps a lesson's former part when no picked part replaces it, so removing the PDF still stops the lesson", async () => {
    const f = fixture(["other.md"]);
    // Short pages: all three are one part now, and page 3 was never picked.
    const book = pdf(f, "book.pdf", ["First page", "Second page", "Third page"], 100);
    for (const k of ["book.pdf#p1-2", "other.md"]) f.progress.saveConcepts(k, "old", [extracted(k)]);
    let sources = ["book.pdf#p1-2", "other.md"];
    f.backend.onRepartition((replace) => (sources = sources.flatMap(replace)));
    expect(await f.library.loadFile(book)).toEqual(["book.pdf"]);
    expect(f.progress.noteHash("book.pdf")).toBeUndefined();
    expect(sources).toEqual(["book.pdf#p1-2", "other.md"]);
    const teach = vi.spyOn(tutor, "teach").mockResolvedValue({} as TeachReply);
    const history: [boolean, string][] = [[false, "Your PDF says…"]];
    await f.backend.teach("idea", sources, history, "Go on");
    expect(teach.mock.calls[0][2]).not.toContain("Third page");
    f.settings.studyFolders = [];
    f.settings.studyFiles = ["other.md"];
    await expect(f.backend.teach("idea", sources, history, "Go on")).rejects.toThrow("Start a new lesson");
    expect(teach).toHaveBeenCalledTimes(1);
  });

  it("moves a former part's concept to the part that finds it again when it's read", async () => {
    const f = fixture([]);
    f.files.push(Object.assign(file("book.pdf"), { extension: "pdf" }));
    const part = { ...note("book.pdf#p6-15"), path: "book.pdf", kind: "pdf" as const, group: "book.pdf" };
    f.library.notes.set(part.key, part);
    // Left on pages 1-10, a range the PDF no longer has.
    f.progress.saveConcepts("book.pdf#p1-10", "old", [extracted("Flow control")]);
    const [flow] = f.progress.data.concepts;
    vi.spyOn(tutor, "extractConcepts").mockResolvedValue({ concepts: [extracted("Flow control")] });
    await f.backend.indexNote(part.key);
    expect(f.progress.data.concepts).toEqual([flow]);
    expect(flow.note_path).toBe(part.key);
  });
});
