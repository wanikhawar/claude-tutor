import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, file, fixture } from "./helpers";

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
