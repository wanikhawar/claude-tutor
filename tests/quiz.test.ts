import { afterEach, describe, expect, it, vi } from "vitest";
import * as tutor from "../src/core/tutor";
import * as providers from "../src/core/providers";
import type { FeynmanEval, Grade, TeachReply } from "../src/core/types";
import { deferred, extracted, fixture, question } from "./helpers";

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
    const ask = vi.spyOn(providers, "ask").mockResolvedValue({ questions: [f.q] });
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
    await f.backend.checkAnswer({ conceptId: f.b.id, question: "Check", key: "Key", misconception: "Different wording", answer: "Yes", misconceptionId: out.misconception_id });
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
    await f.backend.checkAnswer({ conceptId: f.b.id, question: diagnosed.check_question, key: diagnosed.check_answer, misconception: diagnosed.misconception, answer: "No", misconceptionId: out.misconception_id });
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
    const ask = vi.spyOn(providers, "ask").mockResolvedValue({ ...wrong, misconception_id: id });
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
    await f.backend.checkAnswer({ conceptId: f.b.id, question: "Check", key: "Key", misconception: wrong.misconception, answer: "No", misconceptionId: id });
    expect(f.progress.openMisconceptions().map((m) => m.id)).toEqual([id]);
  });
});

const feedback = { score: 40, passed: false, got_right: [], gaps: [{ issue: "Mixes up cause and effect", kind: "wrong" }], reteach: "", analogy: "",
  next_prompt: "", note_issues: [], prerequisite_gap: "", mood: "encouraging", mascot_line: "Nearly" } as unknown as FeynmanEval;
const explain = (conceptId: number) => ({ conceptId, question: "Why?", explanation: "Because", attempt: 0, previousGaps: [], peeked: false, stuck: false });

describe("what goes with a request", () => {
  it("teaches only from notes you picked for Clawd to read", async () => {
    const f = fixture(["picked.md", "unread.md"]);
    f.library.notes.get("picked.md")!.body = "Entropy measures disorder.";
    f.library.notes.get("unread.md")!.body = "Entropy, entropy, entropy: private journal.";
    f.progress.saveConcepts("picked.md", "hash:picked.md", [extracted("Entropy")]);
    expect(f.backend.relevantNotes("entropy")).toEqual(["picked.md"]);
    const teach = vi.spyOn(tutor, "teach").mockResolvedValue({} as TeachReply);
    // Even if a note that was never read gets passed in as a source.
    await f.backend.teach("entropy", ["picked.md", "unread.md"], [], "Start");
    expect(teach.mock.calls[0][2]).toContain("Entropy measures disorder.");
    expect(teach.mock.calls[0][2]).not.toContain("private journal");
  });

  it("sends nothing from a source removed from the library, even mid-quiz", async () => {
    const f = setup();
    const id = f.progress.addMisconception(f.b.id, wrong.misconception);
    f.settings.studyFolders = [];
    const calls = [
      vi.spyOn(tutor, "grade").mockResolvedValue(wrong),
      vi.spyOn(tutor, "makeQuiz").mockResolvedValue({ questions: [f.q], mood: "curious", mascot_line: "Quiz" }),
      vi.spyOn(tutor, "evaluateFeynman").mockResolvedValue(feedback),
      vi.spyOn(tutor, "check").mockResolvedValue({ understood: true, feedback: "", mood: "proud", mascot_line: "" }),
      vi.spyOn(tutor, "chat").mockResolvedValue({ reply: "", mood: "happy", mascot_line: "" }),
      vi.spyOn(tutor, "teach").mockResolvedValue({} as TeachReply),
    ];
    const gone = "no longer in your library";
    await expect(f.backend.gradeAnswer(f.q, 1, "", "unsure")).rejects.toThrow(gone);
    await expect(f.backend.makeQuiz([f.b.id], 1)).rejects.toThrow("No concepts");
    await expect(f.backend.evaluateExplanation(explain(f.b.id))).rejects.toThrow(gone);
    await expect(f.backend.checkAnswer({ conceptId: f.b.id, question: "Check", key: "Key", misconception: "", answer: "Yes", misconceptionId: id })).rejects.toThrow(gone);
    await expect(f.backend.askTutor(f.b.id, "Quiz", [], "Help")).rejects.toThrow(gone);
    await f.backend.teach("idea", ["b.md"], [], "Start");
    for (const call of calls.slice(0, 5)) expect(call).not.toHaveBeenCalled();
    expect(calls[5].mock.calls[0][2]).toBe("");
  });

  it("won't continue a lesson whose note left the library, since its history may quote it", async () => {
    const f = fixture(["picked.md", "other.md"]);
    for (const k of ["picked.md", "other.md"]) f.progress.saveConcepts(k, `hash:${k}`, [extracted(k)]);
    const teach = vi.spyOn(tutor, "teach").mockResolvedValue({} as TeachReply);
    const history: [boolean, string][] = [[false, "Your note says the secret formula is…"]];
    await f.backend.teach("idea", ["picked.md", "other.md"], history, "Go on");
    f.settings.excludedFolders = [];
    f.settings.studyFolders = [];
    f.settings.studyFiles = ["other.md"];
    await expect(f.backend.teach("idea", ["picked.md", "other.md"], history, "Go on")).rejects.toThrow("Start a new lesson");
    expect(teach).toHaveBeenCalledTimes(1);
    // A new lesson starts from the notes still there.
    await f.backend.teach("idea", ["picked.md", "other.md"], [], "Start");
    expect(teach.mock.calls[1][2]).toContain("Content from other.md");
    expect(teach.mock.calls[1][2]).not.toContain("Content from picked.md");
  });

  it("stops Ask Clawd's history before the first turn about a removed note", async () => {
    const f = setup();
    const chat = vi.spyOn(tutor, "chat").mockResolvedValue({ reply: "", mood: "happy", mascot_line: "" });
    const history: [boolean, string, number | null][] = [
      [true, "Hi!", null], [true, "What's this one about?", f.b.id], [false, "It's about…", f.b.id],
      [true, "What's in my other note?", f.a.id], [false, "It says the secret formula is…", f.a.id],
      // About b, but the request carried the turns above, so the reply could quote a.
      [true, "Compare them?", f.b.id], [false, "Unlike the secret formula, …", f.b.id],
    ];
    f.settings.studyFolders = [];
    f.settings.studyFiles = ["b.md"];
    await f.backend.askTutor(f.b.id, "Quiz", history, "Help");
    expect(chat.mock.calls[0][2]).toEqual([[true, "Hi!"], [true, "What's this one about?"], [false, "It's about…"]]);
  });

  it("stops sharing a deleted note's summary and excerpt", async () => {
    const f = setup();
    f.files.splice(f.files.findIndex((x) => x.path === "b.md"), 1);
    const grade = vi.spyOn(tutor, "grade").mockResolvedValue(wrong);
    await expect(f.backend.gradeAnswer(f.q, 1, "", "unsure")).rejects.toThrow("no longer in your library");
    expect(grade).not.toHaveBeenCalled();
  });
});

describe("re-reading a note during a session", () => {
  const reread = (f: ReturnType<typeof setup>) => f.progress.saveConcepts("b.md", "hash:b2", [extracted("Renamed idea")]);

  it("still makes a quiz planned before the re-read", async () => {
    const f = setup();
    reread(f);
    const make = vi.spyOn(tutor, "makeQuiz").mockResolvedValue({ questions: [f.q], mood: "curious", mascot_line: "Quiz" });
    const set = await f.backend.makeQuiz([f.b.id], 1);
    expect(make.mock.calls[0][1].map((m) => m.concept.name)).toEqual(["Shared idea"]);
    vi.spyOn(tutor, "grade").mockResolvedValue(wrong);
    await expect(f.backend.gradeAnswer(set.questions[0], 1, "", "unsure")).resolves.toMatchObject({ grade: wrong });
  });

  it("still makes the quiz after the re-read note is renamed", async () => {
    const f = setup();
    reread(f);
    f.progress.rename("b.md", "moved/b.md");
    f.files.find((x) => x.path === "b.md")!.path = "moved/b.md";
    expect(f.progress.droppedConcept(f.b.id)!.note_path).toBe("moved/b.md");
    vi.spyOn(tutor, "makeQuiz").mockResolvedValue({ questions: [f.q], mood: "curious", mascot_line: "Quiz" });
    await expect(f.backend.makeQuiz([f.b.id], 1)).resolves.toMatchObject({ questions: [f.q] });
  });

  it("still grades a question about a concept the re-read dropped", async () => {
    const f = setup();
    reread(f);
    expect(f.progress.concept(f.b.id)).toBeUndefined();
    const grade = vi.spyOn(tutor, "grade").mockResolvedValue(wrong);
    const out = await f.backend.gradeAnswer(f.q, 1, "", "unsure");
    expect(grade.mock.calls[0][4]).toContain("Concept: Shared idea");
    expect(out).toEqual({ grade: wrong, misconception_id: null });
    expect(f.progress.data.misconceptions).toEqual([]);
  });

  it("doesn't update a concept dropped while it was being graded", async () => {
    const f = setup();
    const pending = deferred<Grade>();
    vi.spyOn(tutor, "grade").mockReturnValue(pending.promise);
    const grading = f.backend.gradeAnswer(f.q, 1, "", "sure");
    reread(f);
    pending.resolve(wrong);
    await grading;
    expect(f.b.lapses).toBe(0);
    expect(f.b.due).toBeNull();
    expect(f.progress.data.misconceptions).toEqual([]);
    expect(f.progress.data.concepts.map((c) => c.name)).toEqual(["Shared idea", "Renamed idea"]);
  });

  it("doesn't update a concept dropped while an explanation was being checked", async () => {
    const f = setup();
    const pending = deferred<FeynmanEval>();
    vi.spyOn(tutor, "evaluateFeynman").mockReturnValue(pending.promise);
    const checking = f.backend.evaluateExplanation(explain(f.b.id));
    reread(f);
    pending.resolve(feedback);
    await expect(checking).resolves.toBe(feedback);
    expect(f.b.reps + f.b.lapses).toBe(0);
    expect(f.b.due).toBeNull();
    expect(f.progress.data.misconceptions).toEqual([]);
  });
});
