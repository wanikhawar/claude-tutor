import { describe, expect, it, vi } from "vitest";
import { clip, parseMarkdown, resolveWikilinks, splitFrontmatter } from "../src/core/notes";
import { cleanPage, split, PART_CHARS } from "../src/core/pdf";
import { EXTRACT_VERSION, Progress, conceptQuestion, emptyProgress } from "../src/core/progress";
import { review } from "../src/core/srs";
import { modelLabel, parseResult } from "../src/core/claude";
import { DEFAULT_SETTINGS, TutorSettingTab, ensureModels, modelName } from "../src/settings";
import { statusGap } from "../src/view";

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

describe("visible models", () => {
  it("keeps the list non-empty and the current model on it", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.models = [];
    s.model = "fable";
    ensureModels(s);
    expect(s.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(s.model).toBe("opus");
  });

  it("switches CLI when the current model's CLI has nothing visible", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.models = [{ provider: "codex", id: "gpt-6-sol", alias: "" }];
    s.provider = "claude";
    s.model = "opus";
    ensureModels(s);
    expect([s.provider, s.model]).toEqual(["codex", "gpt-6-sol"]);
  });

  it("names models by alias, then discovered name, then resolved id", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.models = [
      { provider: "claude", id: "opus", alias: "Deep" },
      { provider: "claude", id: "sonnet", alias: "" },
      { provider: "claude", id: "", alias: "" },
    ];
    s.discovered = [
      { provider: "claude", id: "sonnet", name: "Sonnet 5.5", desc: "", resolved: "claude-sonnet-5-5" },
      { provider: "codex", id: "gpt-6-sol", name: "GPT-6-Sol", desc: "", resolved: "gpt-6-sol" },
    ];
    s.resolvedModels[""] = "claude-opus-5-5";
    expect(modelName(s, "claude", "opus")).toBe("Deep");
    expect(modelName(s, "claude", "sonnet")).toBe("Sonnet 5.5");
    expect(modelName(s, "claude", "")).toBe("Default (Opus 5.5)");
    expect(modelName(s, "claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelName(s, "codex", "gpt-6-sol")).toBe("GPT-6-Sol");
    // An alias on one CLI's model doesn't leak onto another CLI's model with the same id.
    expect(modelName(s, "codex", "opus")).toBe("opus");
  });
});

describe("settings: models in the picker", () => {
  /** The Claude model list as drawn, with saves that don't finish until we say so. */
  function modelList() {
    vi.stubGlobal("createFragment", () => ({}));
    const settings = structuredClone(DEFAULT_SETTINGS);
    let release!: () => void;
    const saved = new Promise<void>((r) => (release = r));
    const plugin = { settings, saveSettings: vi.fn(() => saved) };
    const tab = new TutorSettingTab({} as never, plugin as never) as unknown as {
      update: () => void;
      providerDefinitions: (p: string) => { type?: string; onDelete?: (i: number) => void; onReorder?: (from: number, to: number) => void }[];
    };
    // Like Obsidian, a redraw hands out fresh callbacks built from the current list.
    const draw = () => tab.providerDefinitions("claude").find((d) => d.type === "list")!;
    let drawn = draw();
    tab.update = () => (drawn = draw());
    const list = { onDelete: (i: number) => drawn.onDelete!(i), onReorder: (from: number, to: number) => drawn.onReorder!(from, to) };
    const ids = () => settings.models.map((m) => m.id);
    return { list, ids, release };
  }

  it("keeps each removal when the next comes before the redraw", () => {
    const { list, ids, release } = modelList();
    expect(ids()).toEqual(["opus", "sonnet", "haiku"]);
    // Both clicked before the first save finishes: Opus (row 0), then Sonnet (row 0 once Opus is gone).
    list.onDelete(0);
    list.onDelete(0);
    expect(ids()).toEqual(["haiku"]);
    release();
    vi.unstubAllGlobals();
  });

  it("reads the next drag against the order on screen while a save is pending", () => {
    const { list, ids, release } = modelList();
    list.onReorder(0, 2); // Opus to the bottom: Sonnet, Haiku, Opus
    list.onReorder(0, 1); // then Sonnet, now first on screen, down one
    expect(ids()).toEqual(["haiku", "sonnet", "opus"]);
    release();
    vi.unstubAllGlobals();
  });

  it("moves the model that was dragged, even with another edit pending", () => {
    const { list, ids, release } = modelList();
    list.onDelete(1); // Sonnet
    list.onReorder(1, 0); // Haiku, now second on screen, to the top
    expect(ids()).toEqual(["haiku", "opus"]);
    release();
    vi.unstubAllGlobals();
  });
});

describe("status bar clearance", () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, height: bottom - top });
  const sidebar = box(700, 40, 1000, 600);

  it("keeps clear of the floating status bar over the sidebar's bottom edge", () => {
    expect(statusGap(sidebar, box(780, 574, 1000, 600))).toBe(26);
  });

  it("leaves no gap when the bar is elsewhere, hidden or missing", () => {
    expect(statusGap(sidebar, box(0, 574, 690, 600))).toBe(0); // beside the view, e.g. a full-width theme bar under the main pane
    expect(statusGap(sidebar, box(780, 600, 1000, 626))).toBe(0); // below the view
    expect(statusGap(sidebar, box(0, 0, 0, 0))).toBe(0); // hidden
    expect(statusGap(sidebar, undefined)).toBe(0); // pop-out window
  });
});
