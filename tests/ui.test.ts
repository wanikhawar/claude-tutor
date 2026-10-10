// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Session from "../src/ui/components/Session.svelte";
import Teach from "../src/ui/components/Teach.svelte";
import Library from "../src/ui/components/Library.svelte";
import NavRail from "../src/ui/components/NavRail.svelte";
import ModelPicker from "../src/ui/components/ModelPicker.svelte";
import Clawd from "../src/ui/components/Clawd.svelte";
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
    const input = target.querySelector<HTMLTextAreaElement>("form.ask textarea")!;
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
    // Confidence has no default: submitting without one asks for it first.
    button("Submit").click();
    await settle();
    expect(grade).not.toHaveBeenCalled();
    expect(target.querySelector(".conf.need")).not.toBeNull();
    target.querySelector<HTMLButtonElement>(".conf button[role=radio]")!.click();
    await settle();
    button("Submit").click();
    await settle();
    expect(grade.mock.calls[0][1]).toBe(0);
    expect(grade.mock.calls[0][3]).toBe("guess");
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
    const input = target.querySelector<HTMLTextAreaElement>("form.ask textarea")!;
    type(input, "My unsent draft");
    // Model and effort live in the session header; attach stays in the composer.
    const utilities = [...target.querySelectorAll<HTMLButtonElement>(".top button.pick, form.ask button.attach")];
    expect(utilities).toHaveLength(2);
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
    type(target.querySelector<HTMLTextAreaElement>("form.ask textarea")!, "A question");
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
  component = flushSync(() => mount(NavRail, { target }));
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
    // A lesson in progress asks before it's cleared.
    expect(store.dialog?.title).toBe("Start a new lesson?");
    store.answer("new");
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
    store.answer("new");
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

describe("session safety and composer", () => {
  const fail: FeynmanEval = { score: 20, passed: false, got_right: [], gaps: [], reteach: "Again", analogy: "", next_prompt: "", note_issues: [], prerequisite_gap: "", mood: "encouraging", mascot_line: "Try again" };

  it("asks before replacing a session in progress, and can add the concept to it instead", async () => {
    const [first, second] = store.concepts;
    store.startExplain(first.id);
    const plan = store.plan!;
    component = flushSync(() => mount(Session, { target, props: { plan } }));
    await settle();
    // Nothing done yet: switching is silent.
    expect(store.session?.unfinished()).toBe(false);
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Half an explanation");
    expect(store.session?.unfinished()).toBe(true);

    store.startExplain(second.id);
    await settle();
    expect(store.dialog?.choices.map((c) => c.id)).toEqual(["keep", "add", "new"]);
    store.answer("keep");
    await settle();
    expect(store.plan).toBe(plan);

    store.startExplain(second.id);
    await settle();
    store.answer("add");
    await settle();
    expect(store.plan).toBe(plan);
    expect(target.querySelectorAll(".steps .step")).toHaveLength(2);

    store.startExplain(second.id);
    await settle();
    store.answer("new");
    await settle();
    expect(store.plan).not.toBe(plan);
  });

  it("asks before ending a session with typed work", async () => {
    const plan = { id: 1, title: "Study", steps: [{ kind: "explain" as const, conceptId: store.concepts[0].id }] };
    store.plan = plan;
    component = flushSync(() => mount(Session, { target, props: { plan } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Something");
    button("End session").click();
    await settle();
    expect(store.dialog?.title).toBe("End this session?");
    store.answer("keep");
    await settle();
    expect(store.plan?.id).toBe(1);
  });

  it("sends on Enter, adds a line on Shift+Enter", async () => {
    const evaluate = vi.spyOn(api, "evaluateExplanation").mockResolvedValue(fail);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    const box = target.querySelector<HTMLTextAreaElement>("textarea")!;
    type(box, "Line one");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(evaluate).not.toHaveBeenCalled();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending request and puts the explanation back to edit", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "evaluateExplanation").mockImplementation((a) => {
      signal = a.signal;
      return new Promise((_, reject) => a.signal?.addEventListener("abort", () => reject(new Error("Claude request cancelled."))));
    });
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "My careful explanation");
    button("Submit").click();
    await settle();
    expect(target.querySelector(".mine")).not.toBeNull();
    button("Cancel").click();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(target.querySelector(".mine")).toBeNull();
    expect(target.querySelector(".bubble.err")).toBeNull();
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("My careful explanation");
  });
});

describe("follow-ups", () => {
  it("runs a toast's Undo action after dismissing it", () => {
    const undo = vi.fn();
    store.notify("Marked as resolved.", { label: "Undo", run: undo });
    store.runToastAction();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(store.toast).toBeNull();
  });

  it("doesn't read anything after setup until you pick notes", async () => {
    store.dispose();
    const g = fixture(["a.md", "b.md", "c.md"]);
    store.init(g.backend, () => g.settings, async () => {});
    await store.refresh();
    const read = vi.spyOn(api, "indexNote").mockImplementation(async () => ({ ...store.snap!, notes: store.snap!.notes.map((n) => ({ ...n, stale: false })) }));
    await store.configure(["/"]);
    await store.indexAll();
    expect(read).not.toHaveBeenCalled();
    expect(store.confirmCount).toBeNull();
    await store.readSelected(["a.md"]);
    expect(read.mock.calls.map(([key]) => key)).toEqual(["a.md"]);
  });

  it("pins Clawd's follow-up above the composer and sends it to the grader", async () => {
    const fail: FeynmanEval = { score: 40, passed: false, got_right: [], gaps: [], reteach: "", analogy: "", next_prompt: "Now explain why it matters.", note_issues: [], prerequisite_gap: "", mood: "encouraging", mascot_line: "" };
    const evaluate = vi.spyOn(api, "evaluateExplanation").mockResolvedValue(fail);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    expect(target.querySelector(".turn")).toBeNull();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "First go");
    button("Submit").click();
    await settle();
    expect(target.querySelector(".turn")?.textContent).toContain("Now explain why it matters.");
    expect(evaluate.mock.calls[0][0].followUp).toBe("");
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Because…");
    button("Explain again").click();
    await settle();
    expect(evaluate.mock.calls[1][0].followUp).toBe("Now explain why it matters.");
  });

  it("opens a concept's details in Library instead of starting a session", async () => {
    const c = store.concepts[0];
    component = flushSync(() => mount(Library, { target }));
    await settle();
    // Expand the note, then the concept.
    target.querySelector<HTMLButtonElement>(".note-head")!.click();
    await settle();
    target.querySelector<HTMLButtonElement>("button.concept")!.click();
    await settle();
    expect(store.plan).toBeNull();
    expect(target.querySelector(`#concept-${c.id}`)).not.toBeNull();
    button("Explain it").click();
    await settle();
    expect(store.plan?.steps).toEqual([{ kind: "explain", conceptId: c.id }]);
  });

  it("keeps the model and effort switches under the entry box for narrow panes", async () => {
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    const row = target.querySelector(".composer .model-row");
    const pick = row?.querySelector<HTMLButtonElement>("button.pick.model");
    expect(pick?.textContent).toContain("Medium");
    pick!.click();
    await settle();
    const pop = target.ownerDocument.querySelector(".ct-model-pop");
    // Only the models chosen in settings, in that order.
    expect([...pop!.querySelectorAll("[role=option]")].map((b) => b.textContent?.trim())).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect(pop?.querySelector("[role=slider]")).not.toBeNull();
  });
});

describe("model picker", () => {
  it("works when the tutor is in a pop-out window", async () => {
    // A second document stands in for the pop-out; Svelte only listens on the main one.
    const popout = document.implementation.createHTMLDocument("Pop-out");
    const host = popout.createElement("div");
    popout.body.append(host);
    component = flushSync(() => mount(ModelPicker, { target: host }));
    host.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const pop = popout.body.querySelector<HTMLElement>(".ct-model-pop")!;
    expect(pop.parentElement).toBe(popout.body);
    const opus = [...pop.querySelectorAll<HTMLButtonElement>(".row")].find((b) => b.textContent?.includes("Opus"))!;
    opus.click();
    await settle();
    expect(f.settings.model).toBe("opus");
    expect(popout.body.querySelector(".ct-model-pop")).toBeNull();
  });

  it("offers only explicit effort levels", async () => {
    component = flushSync(() => mount(ModelPicker, { target }));
    target.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const pop = document.querySelector<HTMLElement>(".ct-model-pop")!;
    expect([...pop.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Default")).toBe(false);
    expect(pop.querySelector(".track")!.getAttribute("aria-valuetext")).toBe("Medium");
    expect(target.querySelector(".pick .effort")!.textContent).toBe("· Medium");
  });

  it("closes on Escape without reaching the session", async () => {
    component = flushSync(() => mount(ModelPicker, { target }));
    target.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    document.querySelector<HTMLButtonElement>(".ct-model-pop .row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    document.removeEventListener("keydown", outer);
    expect(document.querySelector(".ct-model-pop")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("caps the popover at the room beside the button", async () => {
    component = flushSync(() => mount(ModelPicker, { target }));
    const btn = target.querySelector<HTMLButtonElement>("button.pick")!;
    // Near the bottom of the window, as under the entry box: it opens upward.
    const top = window.innerHeight - 40;
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({ top, bottom: top + 26, left: 10, right: 120, width: 110, height: 26, x: 10, y: top, toJSON() {} });
    btn.click();
    await settle();
    expect(document.querySelector<HTMLElement>(".ct-model-pop")!.style.maxHeight).toBe(`${top - 14}px`);
  });

  it("fits a very short window instead of overflowing it", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(120);
    component = flushSync(() => mount(ModelPicker, { target }));
    const btn = target.querySelector<HTMLButtonElement>("button.pick")!;
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({ top: 90, bottom: 116, left: 10, right: 120, width: 110, height: 26, x: 10, y: 90, toJSON() {} });
    btn.click();
    await settle();
    const pop = document.querySelector<HTMLElement>(".ct-model-pop")!;
    expect(pop.style.maxHeight).toBe("76px");
    // The whole popover scrolls (no inner scroller to collapse), so every model and the slider stay reachable.
    expect(getComputedStyle(pop).overflowY).toBe("auto");
    expect(pop.querySelectorAll(".row")).toHaveLength(3);
    expect(pop.querySelector(".track")).not.toBeNull();
  });
});

describe("attachments and retries", () => {
  let ids = 1000;
  const img = (url: string): images.Img => ({ id: ids++, url, mediaType: "image/png", data: "eA==", name: `${url}.png` });
  function paste(el: Element, name = "work.png") {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { files: [new File(["x"], name, { type: "image/png" })], items: [] } });
    el.dispatchEvent(e);
  }
  const reply: TeachReply = { reply: "First reply", stage: "teaching", progress: 25, step_title: "Step", summary: "", mood: "curious", mascot_line: "Go" };
  const cancellable = (a: { signal?: AbortSignal } | undefined, signal?: AbortSignal) =>
    new Promise<never>((_, reject) => (a?.signal ?? signal)?.addEventListener("abort", () => reject(new Error("Codex request cancelled."))));

  it("waits for an image being prepared before starting a lesson", async () => {
    const relevant = vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    vi.spyOn(api, "teach").mockResolvedValue(reply);
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Topic");
    paste(target.querySelector("textarea")!);
    await settle();
    expect(target.textContent).toContain("Preparing image…");
    expect(button("Teach me").disabled).toBe(true);
    target.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(relevant).not.toHaveBeenCalled();
    prepared.resolve(img("ready"));
    await settle();
    expect(target.textContent).not.toContain("Preparing image…");
    expect(button("Teach me").disabled).toBe(false);
  });

  it("doesn't carry unsent images into the next quiz question", async () => {
    const conceptId = store.concepts.find((c) => c.note_path === "b.md")!.id;
    const q = question(conceptId);
    vi.spyOn(api, "makeQuiz").mockResolvedValue({ questions: [q, { ...q, question: "Second question?" }], mood: "curious", mascot_line: "Quiz" });
    vi.spyOn(api, "gradeAnswer").mockResolvedValue({
      grade: { correct: true, score: 100, feedback: "Yes", misconception: "", misconception_id: null, prerequisite_gap: "", lesson: "", analogy: "", check_question: "", check_answer: "", mood: "happy", mascot_line: "Good" },
      misconception_id: null,
    });
    const ask = vi.spyOn(api, "askTutor").mockResolvedValue({ reply: "Sure", mood: "happy", mascot_line: "" });
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockResolvedValueOnce(img("old")).mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Quiz", steps: [{ kind: "quiz", conceptIds: [conceptId], count: 2 }] } } }));
    await settle();
    button("Ask Clawd").click();
    await settle();
    paste(target.querySelector("form.ask")!, "old.png");
    paste(target.querySelector("form.ask")!, "pending.png");
    await settle();
    button("Answer").click();
    await settle();
    target.querySelectorAll<HTMLButtonElement>(".opts button")[0].click();
    target.querySelector<HTMLButtonElement>(".conf button[role=radio]")!.click();
    await settle();
    button("Submit").click(); // an MCQ answer takes no images
    await settle();
    button("Next question").click();
    await settle();
    prepared.resolve(img("pending")); // finishes after the question changed
    await settle();
    button("Ask Clawd").click();
    await settle();
    expect(target.querySelector("form.ask .thumbs")).toBeNull();
    type(target.querySelector<HTMLTextAreaElement>("form.ask textarea")!, "About this one");
    target.querySelector<HTMLButtonElement>("form.ask button[type=submit]")!.click();
    await settle();
    expect(ask.mock.calls[0][4]).toEqual([]);
  });

  it("lesson controls wait for an image being prepared", async () => {
    vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    const teach = vi.spyOn(api, "teach").mockResolvedValue(reply);
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Topic");
    button("Teach me").click();
    await settle();
    paste(target.querySelector(".ct-composer")!);
    await settle();
    for (const label of ["Hint", "Show me", "I get it"]) expect(button(label).disabled).toBe(true);
    button("Show me").click();
    await settle();
    expect(teach).toHaveBeenCalledTimes(1);
    prepared.resolve(img("work"));
    await settle();
    button("Show me").click();
    await settle();
    expect(teach).toHaveBeenCalledTimes(2);
    expect(teach.mock.calls[1][4]).toHaveLength(1); // the image went with it
  });

  it("keeps an image being prepared when switching between Answer and Ask Clawd", async () => {
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    paste(target.querySelector(".ct-composer")!);
    await settle();
    button("Ask Clawd").click();
    await settle();
    expect(target.textContent).toContain("Preparing image…");
    prepared.resolve(img("work"));
    await settle();
    expect([...target.querySelectorAll(".ask .thumbs img")].map((i) => i.getAttribute("src"))).toEqual(["work"]);
    button("Answer").click();
    await settle();
    expect([...target.querySelectorAll(".ct-composer .thumbs img")].map((i) => i.getAttribute("src"))).toEqual(["work"]);
  });

  it("doesn't carry unsent images into the next concept", async () => {
    const evaluate = vi.spyOn(api, "evaluateExplanation").mockResolvedValue({ score: 90, passed: true, got_right: [], gaps: [], reteach: "", analogy: "", next_prompt: "", note_issues: [], prerequisite_gap: "", mood: "proud", mascot_line: "" });
    const prepared = deferred<images.Img>();
    vi.spyOn(images, "prepareImage").mockResolvedValueOnce(img("first")).mockReturnValueOnce(prepared.promise);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Two", steps: store.concepts.map((c) => ({ kind: "explain" as const, conceptId: c.id })) } } }));
    await settle();
    paste(target.querySelector(".ct-composer")!, "first.png");
    paste(target.querySelector(".ct-composer")!, "pending.png");
    await settle();
    expect(target.querySelectorAll(".ct-composer .thumbs img")).toHaveLength(1);
    button("I know this").click();
    await settle();
    prepared.resolve(img("pending")); // finishes after the step changed
    await settle();
    expect(target.querySelector(".ct-composer .thumbs")).toBeNull();
    expect(target.textContent).not.toContain("Preparing image…");
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Next concept, in my words");
    button("Submit").click();
    await settle();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0].images).toEqual([]);
  });

  it("keeps an image attached while a cancelled lesson message was sending", async () => {
    vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    vi.spyOn(api, "teach").mockResolvedValueOnce(reply).mockImplementationOnce((_t, _s, _h, _m, _i, signal) => cancellable(undefined, signal));
    vi.spyOn(images, "prepareImage").mockResolvedValueOnce(img("sent")).mockResolvedValueOnce(img("added"));
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Topic");
    button("Teach me").click();
    await settle();
    paste(target.querySelector(".ct-composer")!, "sent.png");
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "My question");
    button("Send").click();
    await settle();
    paste(target.querySelector(".ct-composer")!, "added.png");
    await settle();
    button("Cancel").click();
    await settle();
    expect([...target.querySelectorAll(".ct-composer .thumbs img")].map((i) => i.getAttribute("src"))).toEqual(["sent", "added"]);
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("My question");
  });

  it("never re-runs an old failed explanation while a newer one is being graded", async () => {
    const fail: FeynmanEval = { score: 20, passed: false, got_right: [], gaps: [], reteach: "Again", analogy: "", next_prompt: "", note_issues: [], prerequisite_gap: "", mood: "encouraging", mascot_line: "Try again" };
    const second = deferred<FeynmanEval>();
    const evaluate = vi.spyOn(api, "evaluateExplanation").mockRejectedValueOnce(new Error("network down")).mockReturnValueOnce(second.promise);
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "S", steps: [{ kind: "explain", conceptId: store.concepts[0].id }] } } }));
    await settle();
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "First try");
    button("Submit").click();
    await settle();
    const oldRetry = button("Try again");
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "Edited try");
    button("Submit").click();
    await settle();
    oldRetry.click();
    await settle();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(target.querySelector(".error button")).toBeNull();
    second.resolve(fail);
    await settle();
    expect(evaluate.mock.calls.map(([a]) => a.explanation)).toEqual(["First try", "Edited try"]);
    expect(target.querySelector(".error button")).toBeNull();
  });
});

describe("model list keyboard and search", () => {
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const options = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[role=option]")];

  it("is a list you can move through with the arrow keys and pick from with Enter", async () => {
    f.settings.model = "opus";
    await store.refresh();
    component = flushSync(() => mount(ModelPicker, { target }));
    target.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const list = document.querySelector<HTMLElement>("[role=listbox]")!;
    expect(document.activeElement).toBe(list);
    expect(document.querySelector(".ct-model-pop input")).toBeNull(); // few models: no search box
    expect(options(list).map((o) => [o.textContent?.trim(), o.getAttribute("aria-selected")])).toEqual([["Opus 5.5", "true"], ["Sonnet 5.5", "false"], ["Haiku 5.5", "false"]]);
    // The highlight starts on the current model and moves without changing it.
    expect(list.getAttribute("aria-activedescendant")).toBe(options(list)[0].id);
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    key(list, "ArrowDown"); // stops at the end
    await settle();
    expect(list.getAttribute("aria-activedescendant")).toBe(options(list)[2].id);
    expect(f.settings.model).toBe("opus");
    key(list, "Home");
    key(list, "ArrowDown");
    key(list, "Enter");
    await settle();
    expect(f.settings.model).toBe("sonnet");
    expect(document.querySelector(".ct-model-pop")).toBeNull();
  });

  it("leaves Enter and Esc to an input method that is composing text", async () => {
    f.settings.models = ["opus", "sonnet", "haiku", "fable", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"].map((id) => ({ provider: "claude" as const, id, alias: "" }));
    f.settings.model = "opus";
    await store.refresh();
    component = flushSync(() => mount(ModelPicker, { target }));
    target.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const search = document.querySelector<HTMLInputElement>(".ct-model-pop input")!;
    key(search, "ArrowDown");
    // Confirming or cancelling composed text (isComposing, or keyCode 229 in some browsers).
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    await settle();
    expect(f.settings.model).toBe("opus");
    expect(document.querySelector(".ct-model-pop")).not.toBeNull();
    key(search, "Enter");
    await settle();
    expect(f.settings.model).toBe("sonnet");
  });

  it("adds a search box for a long list, filtering by name or id", async () => {
    f.settings.models = [
      ...["opus", "sonnet", "haiku", "fable", "claude-opus-4-8"].map((id) => ({ provider: "claude" as const, id, alias: "" })),
      ...["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"].map((id) => ({ provider: "codex" as const, id, alias: "" })),
    ];
    await store.refresh();
    // In a pop-out window too, where the popover lives outside the main document.
    const popout = document.implementation.createHTMLDocument("Pop-out");
    const host = popout.createElement("div");
    popout.body.append(host);
    component = flushSync(() => mount(ModelPicker, { target: host }));
    host.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const search = popout.querySelector<HTMLInputElement>(".ct-model-pop input")!;
    expect(search.getAttribute("role")).toBe("combobox");
    search.value = "luna";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const list = popout.querySelector("[role=listbox]")!;
    expect(options(list).map((o) => o.textContent?.trim())).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    expect(search.getAttribute("aria-activedescendant")).toBe(options(list)[0].id);
    key(search, "ArrowDown");
    key(search, "Enter");
    await settle();
    expect([f.settings.provider, f.settings.model]).toEqual(["codex", "gpt-5.6-luna"]);

    host.querySelector<HTMLButtonElement>("button.pick")!.click();
    await settle();
    const again = popout.querySelector<HTMLInputElement>(".ct-model-pop input")!;
    expect(again.value).toBe(""); // a fresh search each time
    again.value = "nothing like this";
    again.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(popout.querySelector(".ct-model-pop")!.textContent).toContain("No models match");
    key(again, "Enter");
    await settle();
    expect(f.settings.model).toBe("gpt-5.6-luna");
  });
});

describe("Teach topic draft", () => {
  it("keeps the unsent topic when the view closes, and forgets it once the lesson starts", async () => {
    const storage = new Map<string, unknown>();
    Object.assign(f.app, { loadLocalStorage: (k: string) => storage.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => (v === null ? storage.delete(k) : storage.set(k, v)) });
    vi.spyOn(api, "relevantNotes").mockResolvedValue([]);
    vi.spyOn(api, "teach").mockResolvedValue({ reply: "Hi", stage: "teaching", progress: 10, step_title: "", summary: "", mood: "curious", mascot_line: "" });
    component = flushSync(() => mount(Teach, { target }));
    type(target.querySelector<HTMLTextAreaElement>("textarea")!, "How do eigenvalues work");
    await settle();
    await unmount(component);
    component = flushSync(() => mount(Teach, { target }));
    await settle();
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("How do eigenvalues work");
    button("Teach me").click();
    await settle();
    await unmount(component);
    component = flushSync(() => mount(Teach, { target }));
    await settle();
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  });
});

describe("Clawd", () => {
  it("is named without an aria-label, which would give it Obsidian's HTML-only tooltip", () => {
    for (const [props, name] of [[{ mood: "happy" }, "Clawd is happy"], [{ mood: "idle", onpoke: () => {} }, "Poke Clawd"]] as const) {
      const target = document.body.appendChild(document.createElement("div"));
      const cmp = mount(Clawd, { target, props });
      flushSync();
      const svg = target.querySelector("svg")!;
      expect(svg.hasAttribute("aria-label")).toBe(false);
      expect(svg.querySelector(":scope > title")!.textContent).toBe(name);
      unmount(cmp);
      target.remove();
    }
  });
});

describe("Ask Clawd history", () => {
  it("drops turns about a removed note once, then remembers new ones", async () => {
    const [a, b] = ["a.md", "b.md"].map((k) => store.concepts.find((c) => c.note_path === k)!.id);
    vi.spyOn(api, "makeQuiz").mockResolvedValue({ questions: [question(a), { ...question(b), question: "About b?" }], mood: "curious", mascot_line: "Quiz" });
    vi.spyOn(api, "gradeAnswer").mockResolvedValue({
      grade: { correct: true, score: 100, feedback: "Yes", misconception: "", misconception_id: null, prerequisite_gap: "", lesson: "", analogy: "", check_question: "", check_answer: "", mood: "happy", mascot_line: "Good" },
      misconception_id: null,
    });
    const replies = ["a's note says the secret is…", "Think of an apple.", "The apple was the idea."];
    const ask = vi.spyOn(api, "askTutor").mockImplementation(async () => ({ reply: replies.shift()!, mood: "happy", mascot_line: "" }));
    component = flushSync(() => mount(Session, { target, props: { plan: { id: 1, title: "Quiz", steps: [{ kind: "quiz", conceptIds: [a, b], count: 2 }] } } }));
    await settle();
    const send = async (text: string) => {
      button("Ask Clawd").click();
      await settle();
      type(target.querySelector<HTMLTextAreaElement>("form.ask textarea")!, text);
      target.querySelector<HTMLButtonElement>("form.ask button[type=submit]")!.click();
      await settle();
    };
    await send("What's in my note?");
    button("Answer").click();
    await settle();
    target.querySelectorAll<HTMLButtonElement>(".opts button")[0].click();
    target.querySelector<HTMLButtonElement>(".conf button[role=radio]")!.click();
    await settle();
    button("Submit").click();
    await settle();
    button("Next question").click();
    await settle();
    // a.md leaves the library.
    f.settings.studyFolders = [];
    f.settings.studyFiles = ["b.md"];
    await send("Explain this one?");
    await send("What did the apple represent?");
    const history = (i: number) => ask.mock.calls[i][2].map(([, text]) => text);
    expect(ask.mock.calls.map((c) => c[0])).toEqual([a, b, b]);
    expect(history(1)).toEqual([]);
    expect(history(2)).toEqual(["Explain this one?", "Think of an apple."]);
  });
});
