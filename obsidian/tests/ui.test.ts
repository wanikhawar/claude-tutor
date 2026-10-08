// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Session from "../src/ui/components/Session.svelte";
import Teach from "../src/ui/components/Teach.svelte";
import TopBar from "../src/ui/components/TopBar.svelte";
import * as tutor from "../src/core/tutor";
import { api, type FeynmanEval, type TeachReply } from "../src/ui/lib/api";
import { store } from "../src/ui/lib/store.svelte";
import * as images from "../src/ui/lib/images";
import { deferred, extracted, fixture, question } from "./helpers";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let f: ReturnType<typeof fixture>;

async function settle() {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}
function button(text: string) {
  const found = [...target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, "empty", { configurable: true, value() { this.replaceChildren(); } });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  target = document.createElement("div");
  document.body.append(target);
  f = fixture();
  for (const n of f.library.notes.values()) f.progress.saveConcepts(n.key, n.hash, [extracted()]);
  store.init(f.backend, () => f.settings, async () => {});
  await store.refresh();
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  store.dispose();
  target.remove();
  vi.restoreAllMocks();
});

describe("session quiz controls", () => {
  it("keeps the active MCQ selectable after asking Clawd and locks earlier questions", async () => {
    const conceptId = store.concepts.find((c) => c.note_path === "b.md")!.id;
    const q = question(conceptId);
    vi.spyOn(api, "makeQuiz").mockResolvedValue({ questions: [q, { ...q, question: "Second question?" }], mood: "curious", mascot_line: "Quiz" });
    const ask = vi.spyOn(api, "askTutor").mockResolvedValue({ reply: "Here is a hint", mood: "happy", mascot_line: "A hint" });
    const grade = vi.spyOn(api, "gradeAnswer").mockResolvedValue({
      grade: { correct: true, score: 100, feedback: "Yes", misconception: "", misconception_id: null, prerequisite_gap: "", lesson: "", analogy: "", check_question: "", check_answer: "", mood: "happy", mascot_line: "Good" },
      misconception_id: null,
    });
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Quiz", steps: [{ kind: "quiz", conceptIds: [conceptId], count: 2 }] } } }));
    await settle();
    target.querySelectorAll<HTMLButtonElement>(".opts button")[1].click();
    button("Ask Clawd").click();
    await settle();
    const input = target.querySelector<HTMLInputElement>("form.ask input[type=text]")!;
    type(input, "Help me think through this");
    target.querySelector<HTMLButtonElement>("form.ask button[type=submit]")!.click();
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe(conceptId);
    button("Answer").click();
    await settle();
    const options = [...target.querySelectorAll<HTMLButtonElement>(".opts button")];
    expect(options.every((b) => !b.disabled)).toBe(true);
    expect(options[1].classList.contains("sel")).toBe(true);
    options[0].click();
    await settle();
    button("Submit").click();
    await settle();
    expect(grade.mock.calls[0][1]).toBe(0);
    button("Next question").click();
    await settle();
    const all = [...target.querySelectorAll<HTMLButtonElement>(".opts button")];
    expect(all.slice(0, 4).every((b) => b.disabled)).toBe(true);
    expect(all.slice(4).every((b) => !b.disabled)).toBe(true);
  });

  it("opens model, effort and attachment pickers without submitting a draft", async () => {
    const conceptId = store.concepts[0].id;
    vi.spyOn(api, "makeQuiz").mockResolvedValue({ questions: [question(conceptId)], mood: "curious", mascot_line: "Quiz" });
    const ask = vi.spyOn(api, "askTutor").mockResolvedValue({ reply: "Reply", mood: "happy", mascot_line: "Hi" });
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Quiz", steps: [{ kind: "quiz", conceptIds: [conceptId], count: 1 }] } } }));
    await settle();
    button("Ask Clawd").click();
    await settle();
    const input = target.querySelector<HTMLInputElement>("form.ask input[type=text]")!;
    type(input, "My unsent draft");
    const utilities = [...target.querySelectorAll<HTMLButtonElement>("form.ask button.pick, form.ask button.attach")];
    expect(utilities).toHaveLength(3);
    for (const utility of utilities) {
      expect(utility.type).toBe("button");
      utility.click();
      await settle();
      expect(ask).not.toHaveBeenCalled();
      expect(input.value).toBe("My unsent draft");
    }
    target.querySelector<HTMLButtonElement>("form.ask button[type=submit]")!.click();
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("session explanations", () => {
  const pass: FeynmanEval = { score: 100, passed: true, got_right: [], gaps: [], reteach: "Passed", analogy: "", next_prompt: "", note_issues: [], prerequisite_gap: "", mood: "celebrating", mascot_line: "Good" };

  it("blocks prerequisite navigation during evaluation and allows it after the reply", async () => {
    const [advanced, foundation] = f.progress.data.concepts;
    advanced.name = "Advanced";
    advanced.questions = ["Why advanced?"];
    foundation.name = "Foundation";
    foundation.questions = ["Why foundation?"];
    await store.refresh();
    const failed = { ...pass, score: 20, passed: false, prerequisite_gap: "Foundation" };
    const pending = deferred<FeynmanEval>();
    const evaluate = vi.spyOn(api, "evaluateExplanation").mockResolvedValueOnce(failed).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(pass);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Study", steps: [{ kind: "explain", conceptId: advanced.id }] } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "First answer");
    button("Submit").click();
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Second answer");
    button("Explain again").click();
    await settle();
    const navigation = button("Learn “Foundation” first");
    expect(navigation.disabled).toBe(true);
    // A programmatic event also exercises the handler's guard.
    navigation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(target.querySelectorAll(".divider")).toHaveLength(1);
    pending.resolve(failed);
    await settle();
    expect(button("Learn “Foundation” first").disabled).toBe(false);
    button("Learn “Foundation” first").click();
    await settle();
    expect(target.querySelectorAll(".divider")[1].textContent).toContain("Foundation");
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Foundation answer");
    button("Submit").click();
    await settle();
    expect(evaluate.mock.calls[2][0]).toMatchObject({ conceptId: foundation.id, question: "Why foundation?" });
    button("Continue").click();
    await settle();
    expect(target.querySelectorAll(".divider")[2].textContent).toContain("Advanced");
  });

  it("blocks prerequisite navigation while an Ask Clawd reply is pending", async () => {
    f.progress.data.concepts[0].name = "Advanced";
    f.progress.data.concepts[1].name = "Foundation";
    await store.refresh();
    const advanced = store.concepts[0].id;
    vi.spyOn(api, "evaluateExplanation").mockResolvedValue({ ...pass, passed: false, score: 20, prerequisite_gap: "Foundation" });
    const pending = deferred<{ reply: string; mood: string; mascot_line: string }>();
    vi.spyOn(api, "askTutor").mockReturnValue(pending.promise);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Study", steps: [{ kind: "explain", conceptId: advanced }] } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "An answer");
    button("Submit").click();
    await settle();
    button("Ask Clawd").click();
    await settle();
    type(target.querySelector<HTMLInputElement>("form.ask input[type=text]")!, "A question");
    target.querySelector<HTMLButtonElement>("form.ask button[type=submit]")!.click();
    await settle();
    expect(button("Learn “Foundation” first").disabled).toBe(true);
    button("Learn “Foundation” first").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(target.querySelectorAll(".divider")).toHaveLength(1);
    pending.resolve({ reply: "A hint", mood: "happy", mascot_line: "Keep going" });
    await settle();
    button("Answer").click();
    await settle();
    expect(target.querySelector("textarea")?.placeholder).toBe("Explain it again, fixing the gaps…");
  });

  it("marks the right result when a same-named concept passes on a retry", async () => {
    vi.spyOn(api, "evaluateExplanation").mockResolvedValueOnce(pass)
      .mockResolvedValueOnce({ ...pass, score: 20, passed: false }).mockResolvedValueOnce(pass);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Two notes", steps: store.concepts.map((c) => ({ kind: "explain" as const, conceptId: c.id })) } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "First concept answer");
    button("Submit").click();
    await settle();
    button("Continue").click();
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Second concept first answer");
    button("Submit").click();
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Second concept improved answer");
    button("Explain again").click();
    await settle();
    button("Finish session").click();
    await settle();
    const summary = [...target.querySelectorAll(".summary li")];
    expect(summary).toHaveLength(2);
    expect(summary.every((x) => x.textContent?.includes("nailed it"))).toBe(true);
    expect(store.line).toContain("2 more things");
  });

  it("marks only the selected same-named concept as self-reported", async () => {
    vi.spyOn(api, "evaluateExplanation").mockResolvedValueOnce(pass).mockResolvedValueOnce({ ...pass, score: 20, passed: false });
    const report = vi.spyOn(api, "selfReport").mockResolvedValue();
    const second = store.concepts[1].id;
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Two notes", steps: store.concepts.map((c) => ({ kind: "explain" as const, conceptId: c.id })) } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "First answer");
    button("Submit").click();
    await settle();
    button("Continue").click();
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Second answer");
    button("Submit").click();
    await settle();
    button("I understand now").click();
    await settle();
    const summary = [...target.querySelectorAll(".summary li")];
    expect(summary[0].textContent).toContain("nailed it");
    expect(summary[1].textContent).toContain("marked as understood by you");
    expect(report).toHaveBeenCalledWith(second, "understood");
  });
});

it("retries the failed manual read from the banner with automatic re-reading disabled", async () => {
  f.settings.autoIndex = false;
  f.progress.saveConcepts("a.md", "old-hash", [extracted()]);
  const extract = vi.spyOn(tutor, "extractConcepts").mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce({ concepts: [extracted()] });
  component = flushSync(() => mount(TopBar, { target }));
  expect(await store.indexOne("a.md")).toBe(false);
  await settle();
  target.querySelector<HTMLButtonElement>(".chip.bad")!.click();
  await settle();
  expect(extract).toHaveBeenCalledTimes(2);
  expect(store.indexError).toBeNull();
  expect(target.querySelector(".chip.bad")).toBeNull();
});

describe("Teach lesson resets", () => {
  const reply: TeachReply = { reply: "Old topic reply", stage: "teaching", progress: 25, step_title: "First step", summary: "", mood: "curious", mascot_line: "Let's learn" };

  it("prevents resetting during a reply, then starts the replacement topic normally", async () => {
    vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    const pending = deferred<TeachReply>();
    const teach = vi.spyOn(api, "teach").mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...reply, reply: "New topic reply" });
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Old topic");
    button("Teach me").click();
    await settle();
    expect(button("New lesson").disabled).toBe(true);
    button("New lesson").click();
    await settle();
    expect(target.querySelector("h3")?.textContent).toBe("Old topic");
    pending.resolve(reply);
    await settle();
    expect(button("New lesson").disabled).toBe(false);
    button("New lesson").click();
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "New topic");
    button("Teach me").click();
    await settle();
    expect(teach.mock.calls.map(([topic]) => topic)).toEqual(["Old topic", "New topic"]);
    expect(target.textContent).toContain("New topic reply");
    expect(target.textContent).not.toContain("Old topic reply");
  });

  it("does not move a pending image from the old lesson into its replacement", async () => {
    vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    vi.spyOn(api, "teach").mockResolvedValue(reply);
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Old topic");
    button("Teach me").click();
    await settle();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    const png = new File(["x"], "work.png", { type: "image/png" });
    Object.defineProperty(paste, "clipboardData", { value: { files: [png], items: [] } });
    target.querySelector(".ct-composer")!.dispatchEvent(paste);
    button("New lesson").click();
    await settle();
    prepared.resolve({ url: "blob:old", mediaType: "image/png", data: "eA==", name: "work.png" } as images.Img);
    await settle();
    expect(target.querySelector(".thumbs")).toBeNull();
  });

  it("also prevents resets and sends while finding relevant notes", async () => {
    const sources = deferred<string[]>();
    vi.spyOn(api, "relevantNotes").mockReturnValueOnce(sources.promise);
    const teach = vi.spyOn(api, "teach").mockResolvedValue(reply);
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Topic");
    button("Teach me").click();
    await settle();
    expect(button("New lesson").disabled).toBe(true);
    expect(button("Send").disabled).toBe(true);
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Wait for sources");
    button("Send").click();
    await settle();
    expect(teach).not.toHaveBeenCalled();
    sources.resolve([]);
    await settle();
    expect(teach).toHaveBeenCalledTimes(1);
  });
});
