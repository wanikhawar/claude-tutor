// Hits the real Claude CLI (uses Haiku). Run with: CLAUDE_LIVE=1 npx vitest run tests/live.test.ts
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { evaluateFeynman, extractConcepts, grade, teach, TEACH_CONTROLS } from "../src/core/tutor";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Concept } from "../src/core/types";

const live = process.env.CLAUDE_LIVE ? describe : describe.skip;
const opts = { path: "", model: "haiku", cwd: tmpdir() };
const NOTE = `# Kinetic energy
A moving object of mass $m$ and speed $v$ has kinetic energy
$$E_k = \\tfrac{1}{2} m v^2$$
Doubling the speed quadruples the kinetic energy, because energy grows with the square of speed.`;

live("live Claude", () => {
  it("extracts concepts and teaches with LaTeX math", { timeout: 180_000 }, async () => {
    const { concepts } = await extractConcepts(opts, "Kinetic energy", NOTE, []);
    expect(concepts.length).toBeGreaterThan(0);
    const concept: Concept = {
      id: 1, note_path: "ke.md", ...concepts[0], ease: 2.5, interval_days: 0, reps: 0, lapses: 0,
      due: null, mastery: 0, last_reviewed: null,
    };
    console.log(concepts.map((x) => `${x.name}\n   ? ${x.questions.join("\n   ? ")}`).join("\n"));
    expect(concepts.every((x) => x.questions.length >= 2)).toBe(true);
    expect(concepts.flatMap((x) => x.questions).some((q) => /^explain\b/i.test(q.trim()))).toBe(false);
    const ev = await evaluateFeynman(opts, {
      concept, question: concept.questions[0], noteTitle: "Kinetic energy", noteBody: NOTE, attempt: 0,
      explanation: "Kinetic energy is mass times speed, so twice as fast means twice the energy.",
      previousGaps: [], peeked: false, stuck: false,
    });
    const text = [ev.reteach, ev.analogy, ...ev.gaps.flatMap((g) => [g.issue, g.fix])].join("\n");
    console.log(text);
    expect(ev.passed).toBe(false);
    expect(text).toMatch(/\$[^$]+\$/); // uses $...$ math
    expect(text).not.toMatch(/\\\(|\\\[/); // never \( \) or \[ \]
  });
});

live("live Claude: images and teaching", () => {
  it("grades handwritten-style working from an image", { timeout: 180_000 }, async () => {
    const png = join(tmpdir(), "ct-work.png");
    execFileSync("magick", ["-size", "420x160", "xc:white", "-fill", "black", "-pointsize", "36", "-annotate", "+20+60", "2x + 3 = 11", "-annotate", "+20+120", "x = 7", png]);
    const q = { concept_id: 1, misconception_id: null, concept: "Linear equations", kind: "short" as const, question: "Solve $2x + 3 = 11$.", options: [], correct_option: -1, answer: "$x = 4$", explanation: "Subtract 3, divide by 2." };
    const g = await grade(opts, q, "", "confident", "", [{ mediaType: "image/png", data: readFileSync(png).toString("base64") }]);
    console.log("grade:", g.correct, "|", g.feedback, "|", g.misconception);
    expect(g.correct).toBe(false);
    expect(g.feedback + g.misconception).toMatch(/7/);
  });

  it("teaches Socratically: short turn ending in a question, no answer dump", { timeout: 180_000 }, async () => {
    const r = await teach(opts, "Why does kinetic energy depend on v squared?", "", [], `${TEACH_CONTROLS.start}\n\nWhy does kinetic energy depend on v squared?`);
    console.log("teach:", r.stage, r.progress, r.step_title, "|", r.reply);
    expect(r.reply.trim().slice(-300)).toContain("?"); // ends by asking the learner something
    expect(r.reply.split(/\s+/).length).toBeLessThan(180);
    expect(r.stage).not.toBe("wrap_up");
  });
});
