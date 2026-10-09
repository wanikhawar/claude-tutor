import { afterEach, describe, expect, it, vi } from "vitest";
import * as tutor from "../src/core/tutor";
import * as claude from "../src/core/claude";
import type { Grade } from "../src/core/types";
import { extracted, fixture, question } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const f = fixture();
  for (const n of f.library.notes.values()) f.progress.saveConcepts(n.key, n.hash, [extracted()]);
  const [a, b] = f.progress.data.concepts;
  const q = question(b.id);
  return { ...f, a, b, q };
}
const wrong: Grade = {
  correct: false, score: 0, feedback: "Try again", misconception: "Thinks the wrong answer is right", misconception_id: null, prerequisite_gap: "",
  lesson: "A correction", analogy: "", check_question: "Did it click?", check_answer: "Yes", mood: "encouraging", mascot_line: "Keep trying",
};

describe("quiz identities", () => {
  it("preserves the selected concept ID and reviews the correct note for duplicate names", async () => {
    const f = setup();
    const make = vi.spyOn(tutor, "makeQuiz").mockResolvedValue({ questions: [f.q], mood: "curious", mascot_line: "Quiz" });
    const set = await f.backend.makeQuiz([f.b.id], 1);
    expect(make.mock.calls[0][1].map((m) => m.concept.id)).toEqual([f.b.id]);
    await f.backend.gradeAnswer(set.questions[0], 0, "", "sure");
    expect(f.a.reps).toBe(0);
    expect(f.b.reps).toBe(1);
    expect(f.progress.data.attempts[0].concept_id).toBe(f.b.id);
  });

  it("grades incorrect answers against the selected note's context", async () => {
    const f = setup();
    const grade = vi.spyOn(tutor, "grade").mockResolvedValue(wrong);
    await f.backend.gradeAnswer(f.q, 1, "", "unsure");
    expect(grade.mock.calls[0][4]).toContain("Content from b.md");
    expect(grade.mock.calls[0][4]).not.toContain("Content from a.md");
    expect(f.progress.openMisconceptions()[0].concept_id).toBe(f.b.id);
  });

  it("rejects question IDs outside the selected pool rather than finding a name match", async () => {
    const f = setup();
    vi.spyOn(tutor, "makeQuiz").mockResolvedValue({ questions: [question(f.a.id)], mood: "curious", mascot_line: "Quiz" });
    await expect(f.backend.makeQuiz([f.b.id], 1)).rejects.toThrow("outside this quiz");
  });

  it("includes concept and misconception IDs in the generation prompt and schema", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    const ask = vi.spyOn(claude, "ask").mockResolvedValue({ questions: [f.q] });
    await tutor.makeQuiz({ path: "", model: "", cwd: "/tmp" }, [{ concept: f.b, noteTitle: "B", noteBody: "body" }], [{ id, concept_id: f.b.id, text: wrong.misconception }], 1);
    expect(ask.mock.calls[0][2]).toContain(`Concept ID ${f.b.id}`);
    expect(ask.mock.calls[0][2]).toContain(`Misconception ID ${id}`);
    expect(ask.mock.calls[0][3]).toMatchObject({ properties: { questions: { items: { properties: {
      concept_id: { enum: [f.b.id] }, misconception_id: { enum: [null, id] },
    } } } } });
  });
});

describe("targeted misconception practice", () => {
  it("keeps the original mistake ID on failure and resolves it after a successful check", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    f.q.misconception_id = id;
    vi.spyOn(tutor, "grade").mockResolvedValue({ ...wrong, misconception_id: id });
    const out = await f.backend.gradeAnswer(f.q, 1, "", "sure");
    expect(out.misconception_id).toBe(id);
    expect(f.progress.data.misconceptions).toHaveLength(1);
    const check = vi.spyOn(tutor, "check").mockResolvedValue({ understood: true, feedback: "Got it", mood: "proud", mascot_line: "Yes" });
    await f.backend.checkAnswer({ question: "Check", key: "Key", misconception: "Different wording", answer: "Yes", misconceptionId: out.misconception_id });
    expect(check.mock.calls[0][3]).toBe(wrong.misconception);
    expect(f.progress.openMisconceptions()).toEqual([]);
  });

  it("reuses the target ID when grading describes the same belief in different words", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    f.q.misconception_id = id;
    const grade = vi.spyOn(tutor, "grade").mockResolvedValue({ ...wrong, misconception_id: id, misconception: "The original belief, rephrased" });
    const out = await f.backend.gradeAnswer(f.q, 1, "", "unsure");
    expect(grade.mock.calls[0][6]).toMatchObject({ id, text: wrong.misconception });
    expect(out.misconception_id).toBe(id);
    expect(f.progress.data.misconceptions).toHaveLength(1);
  });

  it("records a different diagnosis and resolves only that mistake after its follow-up check", async () => {
    const f = setup();
    const original = f.progress.addMisconception(f.b.id, "Thinks kinetic energy is linear in speed");
    f.q.misconception_id = original;
    const diagnosed = { ...wrong, misconception: "Thinks mass can be negative", check_question: "Can mass be negative?", check_answer: "No" };
    vi.spyOn(tutor, "grade").mockResolvedValue(diagnosed);
    const out = await f.backend.gradeAnswer(f.q, 1, "", "sure");
    expect(out.misconception_id).not.toBe(original);
    expect(f.progress.openMisconceptions().map((m) => m.text)).toContain(diagnosed.misconception);
    const check = vi.spyOn(tutor, "check").mockResolvedValue({ understood: true, feedback: "Mass is positive", mood: "proud", mascot_line: "Yes" });
    await f.backend.checkAnswer({ question: diagnosed.check_question, key: diagnosed.check_answer, misconception: diagnosed.misconception, answer: "No", misconceptionId: out.misconception_id });
    expect(check.mock.calls[0][3]).toBe(diagnosed.misconception);
    expect(f.progress.openMisconceptions().map((m) => m.id)).toEqual([original]);
  });

  it("keeps the target unresolved when a wrong answer is just a slip", async () => {
    const f = setup();
    const original = f.progress.addMisconception(f.b.id, wrong.misconception);
    f.q.misconception_id = original;
    vi.spyOn(tutor, "grade").mockResolvedValue({ ...wrong, misconception: "" });
    const out = await f.backend.gradeAnswer(f.q, 1, "", "unsure");
    expect(out.misconception_id).toBeNull();
    expect(f.progress.openMisconceptions().map((m) => m.id)).toEqual([original]);
  });

  it("rejects an unrelated diagnosis ID before updating progress", async () => {
    const f = setup();
    const unrelated = f.progress.addMisconception(f.a.id, "Different note's mistake");
    vi.spyOn(tutor, "grade").mockResolvedValue({ ...wrong, misconception_id: unrelated });
    await expect(f.backend.gradeAnswer(f.q, 1, "", "unsure")).rejects.toThrow("unrelated misconception");
    expect(f.b.reps).toBe(0);
    expect(f.b.lapses).toBe(0);
    expect(f.progress.data.attempts).toEqual([]);
  });

  it("rejects a missing diagnosis identity before updating progress", async () => {
    const f = setup();
    const { misconception_id: _id, ...incomplete } = wrong;
    vi.spyOn(tutor, "grade").mockResolvedValue(incomplete as Grade);
    await expect(f.backend.gradeAnswer(f.q, 1, "", "unsure")).rejects.toThrow("unrelated misconception");
    expect(f.progress.data.attempts).toEqual([]);
    expect(f.progress.data.misconceptions).toEqual([]);
  });

  it("includes the target ID in grading and limits diagnosis IDs to that target", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    const ask = vi.spyOn(claude, "ask").mockResolvedValue({ ...wrong, misconception_id: id });
    await tutor.grade({ path: "", model: "", cwd: "/tmp" }, f.q, "Wrong", "unsure", "Note context", [], { id, concept_id: f.b.id, text: wrong.misconception });
    expect(ask.mock.calls[0][2]).toContain(`Existing misconception: ID ${id}`);
    expect(ask.mock.calls[0][3]).toMatchObject({ properties: { misconception_id: { enum: [null, id] } } });
  });

  it("resolves the original mistake when the targeted quiz answer is correct", async () => {
    const f = setup();
    f.q.misconception_id = f.progress.addMisconception(f.b.id, wrong.misconception);
    await f.backend.gradeAnswer(f.q, 0, "", "sure");
    expect(f.progress.openMisconceptions()).toEqual([]);
  });

  it("leaves the original mistake open when the follow-up check fails", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    vi.spyOn(tutor, "check").mockResolvedValue({ understood: false, feedback: "Not yet", mood: "encouraging", mascot_line: "Try again" });
    await f.backend.checkAnswer({ question: "Check", key: "Key", misconception: wrong.misconception, answer: "No", misconceptionId: id });
    expect(f.progress.openMisconceptions().map((m) => m.id)).toEqual([id]);
  });
});
