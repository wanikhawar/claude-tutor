import { describe, expect, it } from "vitest";
import { clip, parseMarkdown, resolveWikilinks, splitFrontmatter } from "../src/core/notes";
import { cleanPage, split, PART_CHARS } from "../src/core/pdf";
import { EXTRACT_VERSION, Progress, conceptQuestion, emptyProgress } from "../src/core/progress";
import { review } from "../src/core/srs";
import { modelLabel, parseResult } from "../src/core/claude";

describe("notes", () => {
  it("strips frontmatter", () => {
    expect(splitFrontmatter("---\ntitle: Hi\ntags: [a]\n---\n# Body\ntext")).toEqual(["title: Hi\ntags: [a]", "# Body\ntext"]);
    expect(splitFrontmatter("# No front")[1]).toBe("# No front");
  });
  it("resolves wikilinks", () => {
    const [out, links] = resolveWikilinks("See [[TCP|the TCP note]] and [[UDP#Header]] ![[diagram.png]].");
    expect(out).toBe("See the TCP note and UDP#Header diagram.png.");
    expect(links).toEqual(["TCP", "UDP", "diagram.png"]);
  });
  it("titles, comments and math survive parsing", () => {
    const n = parseMarkdown("---\ntags: x\n---\n# Energy\n%%hidden%%Mass–energy: $E = mc^2$", "file");
    expect(n.title).toBe("Energy");
    expect(n.body).toContain("$E = mc^2$");
    expect(n.body).not.toContain("hidden");
  });
  it("clips", () => {
    expect(clip("abcdef", 3)).toBe("abc\n…[truncated]");
  });
});

describe("pdf", () => {
  it("reflows lines, headings, bullets and ligatures", () => {
    const raw =
      "1. Transport\nThe Transmission Con-\ntrol Protocol keeps a byte stream reliable and\nordered for apps.\n\n•\n\nfirst item\n\nﬁne";
    expect(cleanPage(raw)).toBe(
      "1. Transport\nThe Transmission Control Protocol keeps a byte stream reliable and ordered for apps.\n\n• first item\n\nfine",
    );
  });
  it("splits on page boundaries", () => {
    const big = "x".repeat(PART_CHARS / 2 + 100);
    const parts = split([big, big, "", big]);
    expect(parts.map((p) => [p.first, p.last])).toEqual([
      [1, 1],
      [2, 3],
      [4, 4],
    ]);
    expect(parts[1].text.startsWith("[Page 2]")).toBe(true);
  });
  it("keeps short documents in one part", () => {
    expect(split(["a", "b"])).toEqual([{ first: 1, last: 2, text: "[Page 1]\n\na\n\n[Page 2]\n\nb" }]);
  });
});

describe("progress + srs", () => {
  const c = (name: string, questions: string[] = []) => ({ name, summary: "s", prerequisites: [], excerpt: "", questions });
  it("re-indexing keeps progress and drops stale concepts", () => {
    const p = new Progress(emptyProgress());
    p.saveConcepts("n.md", "h1", [c("A"), c("B")]);
    review(p.data.concepts.find((x) => x.name === "A")!, 1);
    p.saveConcepts("n.md", "h2", [c("A"), c("C")]);
    const cs = p.conceptsFor(new Set(["n.md"]));
    expect(cs.map((x) => x.name)).toEqual(["A", "C"]);
    expect(cs[0].reps).toBe(1);
    expect(p.noteHash("n.md")).toBe("h2");
  });
  it("failing a review resets and counts a lapse", () => {
    const p = new Progress(emptyProgress());
    p.saveConcepts("n.md", "h", [c("A")]);
    const x = p.data.concepts[0];
    review(x, 0.9);
    review(x, 0.9);
    expect(x.interval_days).toBe(3);
    review(x, 0.2);
    expect([x.reps, x.lapses, x.interval_days]).toEqual([0, 1, 0]);
  });
  it("renames keep progress, including PDF parts", () => {
    const p = new Progress(emptyProgress());
    p.saveConcepts("a/book.pdf#p1-9", "h", [c("A")]);
    p.saveConcepts("a/x.md", "h", [c("B")]);
    p.rename("a/book.pdf", "b/book.pdf");
    expect(p.data.concepts.map((x) => x.note_path)).toEqual(["b/book.pdf#p1-9", "a/x.md"]);
    expect(p.noteHash("b/book.pdf#p1-9")).toBe("h");
  });
  it("folder renames move descendant notes and PDF parts without matching sibling prefixes", () => {
    const p = new Progress(emptyProgress());
    p.saveConcepts("a/book.pdf#p1-9", "h", [c("A")]);
    p.saveConcepts("a/sub/x.md", "h", [c("B")]);
    p.saveConcepts("another/y.md", "h", [c("C")]);
    p.rename("a", "b");
    expect(p.data.concepts.map((x) => x.note_path)).toEqual(["b/book.pdf#p1-9", "b/sub/x.md", "another/y.md"]);
    expect(p.noteHash("b/book.pdf#p1-9")).toBe("h");
    expect(p.noteHash("a/sub/x.md")).toBeUndefined();
  });
  it("rotates focused questions across reviews", () => {
    const p = new Progress(emptyProgress());
    p.saveConcepts("n.md", "h", [c("KE grows with v squared", [" Why does doubling speed quadruple KE? ", "What if mass doubles?"])]);
    const x = p.data.concepts[0];
    expect(conceptQuestion(x)).toBe("Why does doubling speed quadruple KE?");
    review(x, 1);
    expect(conceptQuestion(x)).toBe("What if mass doubles?");
    x.questions = [];
    expect(conceptQuestion(x)).toBe("Explain KE grows with v squared in your own words.");
  });
  it("re-reads notes indexed with older extraction rules", () => {
    const data = emptyProgress();
    data.notes["old.md"] = { hash: "h", indexed_at: "", v: 1 };
    data.concepts.push({ ...c("A"), id: 1, note_path: "old.md", ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due: null, mastery: 0, last_reviewed: null } as never);
    delete (data.concepts[0] as { questions?: string[] }).questions; // files from before questions existed
    const p = new Progress(data);
    expect(p.data.concepts[0].questions).toEqual([]);
    expect(p.isCurrent("old.md", "h")).toBe(false);
    p.saveConcepts("old.md", "h", [c("A")]);
    expect(p.isCurrent("old.md", "h")).toBe(true);
    expect(p.data.notes["old.md"].v).toBe(EXTRACT_VERSION);
  });
  it("misconceptions open and resolve", () => {
    const p = new Progress(emptyProgress());
    const id = p.addMisconception(1, " Thinks X ");
    expect(p.openMisconceptions().map((m) => m.text)).toEqual(["Thinks X"]);
    p.resolveMisconception(id);
    expect(p.openMisconceptions()).toEqual([]);
  });
  it("reuses an open misconception on the same concept but keeps other concepts separate", () => {
    const p = new Progress(emptyProgress());
    const id = p.addMisconception(1, "Thinks X");
    expect(p.addMisconception(1, " thinks x ")).toBe(id);
    expect(p.addMisconception(2, "Thinks X")).not.toBe(id);
    p.resolveMisconception(id);
    expect(p.addMisconception(1, "Thinks X")).not.toBe(id);
  });
});

describe("activity, streaks and misconception context", () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it("counts reviews per local day and the current streak", () => {
    const p = new Progress(emptyProgress());
    p.data.attempts = [at(2026, 9, 5), at(2026, 9, 7), at(2026, 9, 8), at(2026, 9, 8, 22), at(2026, 9, 9, 1)].map((ts) => ({ concept_id: 1, kind: "quiz", score: 1, ts }));
    const now = new Date(2026, 9, 9, 15);
    expect(p.activity(7, now)).toEqual([0, 0, 1, 0, 1, 2, 1]);
    expect(p.streak(now)).toBe(3);
    // No review yet today: yesterday's streak still counts.
    expect(p.streak(new Date(2026, 9, 10, 9))).toBe(3);
    expect(p.streak(new Date(2026, 9, 11, 9))).toBe(0);
  });

  it("remembers the question behind a misconception and can reopen it", () => {
    const p = new Progress(emptyProgress());
    const id = p.addMisconception(1, "Thinks heavier things fall faster", "Why do a hammer and a feather land together?");
    expect(p.openMisconceptions()[0].source).toBe("Why do a hammer and a feather land together?");
    p.resolveMisconception(id);
    expect(p.openMisconceptions()).toHaveLength(0);
    p.reopenMisconception(id);
    expect(p.openMisconceptions().map((m) => m.id)).toEqual([id]);
  });
});

describe("claude result parsing", () => {
  it("prefers structured output", () => {
    const out = JSON.stringify({
      subtype: "success",
      is_error: false,
      result: "",
      structured_output: { a: 1 },
      modelUsage: { "claude-sonnet-5-5": {} },
    });
    expect(parseResult(out, "", 0)).toEqual({ data: { a: 1 }, models: ["claude-sonnet-5-5"] });
  });
  it("falls back to JSON in the text and reports errors", () => {
    expect(parseResult(JSON.stringify({ subtype: "success", result: 'ok {"b":2} done' }), "", 0).data).toEqual({ b: 2 });
    expect(() => parseResult(JSON.stringify({ subtype: "error", is_error: true, result: "nope" }), "", 1)).toThrow(/nope/);
    expect(() => parseResult("garbage", "boom", 1)).toThrow(/boom/);
  });
});

describe("claude plain-text replies", () => {
  it("shows Claude Code's own message (e.g. model not available)", () => {
    const out = JSON.stringify({ subtype: "success", is_error: false, result: "Fable 5.1 requires usage credits." });
    expect(() => parseResult(out, "", 0)).toThrow(/Fable 5.1 requires usage credits/);
  });
});

describe("model names", () => {
  it("turns model ids into readable names", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-haiku-5-5-20260601")).toBe("Haiku 5.5");
    expect(modelLabel("some-other-model")).toBe("some-other-model");
  });
});
