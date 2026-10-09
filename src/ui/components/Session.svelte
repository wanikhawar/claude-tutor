<!--
  A study session as a conversation with Clawd. A plan is a list of steps:
  "explain" (Feynman loop on one concept) and "quiz" (questions, grading, checks).
  The composer at the bottom always shows the next thing to do.
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    api,
    asMood,
    errText,
    isCancel,
    obsidianApp,
    type CheckResult,
    type Confidence,
    type FeynmanEval,
    type Gap,
    type Grade,
    type Mood,
    type Question,
  } from "../lib/api";
  import { store, isNew, type Plan, type Step } from "../lib/store.svelte";
  import { conceptQuestion } from "../../core/progress";
  import Clawd from "./Clawd.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import FeedbackCard from "./FeedbackCard.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import GradeCard from "./GradeCard.svelte";
  import Ring from "./Ring.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import AttachButton from "./AttachButton.svelte";
  import SendButton from "./SendButton.svelte";
  import Thumbs from "./Thumbs.svelte";
  import { imageFiles, toInputs, type Img } from "../lib/images";
  import { enterToSend, loadDraft, masteryColor, masteryLevel, relativeDue, saveDraft, scoreColor, SEND_HINT } from "../lib/util";

  let { plan }: { plan: Plan } = $props();

  type Msg = { id: number } & (
    | { kind: "say"; md: string; mood: Mood; source?: string }
    | { kind: "me"; text: string; note?: string; images?: string[] }
    | { kind: "feedback"; ev: FeynmanEval; stuck: boolean; conceptId: number; mood: Mood }
    | { kind: "question"; q: Question; n: number; total: number; answered: number | null; mood: Mood }
    | { kind: "grade"; g: Grade; q: Question; mood: Mood }
    | { kind: "check"; r: CheckResult; mood: Mood }
    | { kind: "error"; text: string; retry: () => void; mood: Mood }
    | { kind: "divider"; text: string }
    | { kind: "summary"; mood: Mood }
  );

  type Phase =
    | { p: "busy" }
    | { p: "explain"; conceptId: number; attempt: number; peeked: boolean; gaps: Gap[]; lastExplanation: string; lastReteach: string }
    | { p: "explained"; conceptId: number; attempt: number; gaps: Gap[]; lastExplanation: string; lastReteach: string }
    | { p: "quiz"; questions: Question[]; idx: number; stage: "answer" | "graded" | "check" | "checked"; grade?: Grade; miscId?: number | null }
    | { p: "done" };

  // svelte-ignore state_referenced_locally
  let steps = $state<Step[]>([...plan.steps]);
  let stepIdx = $state(0);
  let msgs = $state<Msg[]>([]);
  let phase = $state<Phase>({ p: "busy" });
  let resume = $state<Phase | null>(null);
  let thinking = $state(false);
  let draft = $state("");
  let ask = $state("");
  let mode = $state<"answer" | "ask">("answer");
  let choice = $state<number | null>(null);
  /** No default: a rating the learner actually chose is a much better signal. */
  let confidence = $state<Confidence | null>(null);
  let needConfidence = $state(false);
  /** The Claude request in flight, so it can be cancelled. */
  let request: AbortController | null = null;
  /** The reply is taking longer than usual. */
  let slow = $state(false);
  /** A request with no earlier state to return to failed or was cancelled: retry it, or skip the step. */
  let stalled = $state<(() => void) | null>(null);
  let threadEl = $state<HTMLDivElement>();
  /** Images attached to the message being composed. */
  let images = $state<Img[]>([]);
  let attacher = $state<AttachButton>();

  /** Take the attached images for sending (and clear the composer). */
  function takeImages() {
    const taken = images;
    images = [];
    return { inputs: toInputs(taken), urls: taken.map((i) => i.url), taken };
  }

  function onPaste(e: ClipboardEvent) {
    const files = imageFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void attacher?.add(files);
    }
  }

  function onDrop(e: DragEvent) {
    const files = imageFiles(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      void attacher?.add(files);
    }
  }

  /** The focused question being asked in the current explain step. */
  let question = $state("");
  let inputEl = $state<HTMLTextAreaElement>();
  let rootEl = $state<HTMLDivElement>();

  const results = $state<{
    explained: { conceptId: number; name: string; score: number | null; passed: boolean; self?: boolean }[];
    quiz: { score: number; correct: boolean }[];
  }>({
    explained: [],
    quiz: [],
  });
  let chat: [boolean, string][] = [];
  /** Mastery of each concept this session touched, as it was before. */
  const before = new Map<number, number>();
  let touched = $state<number[]>([]);
  function touch(...ids: number[]) {
    for (const id of ids) {
      if (before.has(id)) continue;
      before.set(id, store.concept(id)?.mastery ?? 0);
      touched.push(id);
    }
  }
  let nextId = 1;
  let activeQuestionId = $state<number | null>(null);

  const lastClawd = $derived([...msgs].reverse().find((m) => m.kind !== "me" && m.kind !== "divider")?.id);

  /** Cards that can be taller than the viewport open at their top, not their bottom. */
  const TALL = ["feedback", "grade", "question", "summary"];

  function push(m: Omit<Msg, "id"> & Record<string, unknown>) {
    const id = nextId++;
    msgs.push({ ...(m as Msg), id });
    if (TALL.includes(m.kind as string)) void scrollToMsg(id);
    else void scrollDown();
    return id;
  }

  async function scrollToMsg(id: number) {
    await tick();
    const el = threadEl?.querySelector<HTMLElement>(`[data-msg="${id}"]`);
    if (el && threadEl && el.offsetHeight > threadEl.clientHeight * 0.6) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      void scrollDown();
    }
  }

  async function scrollDown() {
    await tick();
    threadEl?.scrollTo({ top: threadEl.scrollHeight, behavior: "smooth" });
  }

  async function focusInput() {
    await tick();
    inputEl?.focus();
  }

  /**
   * Run a Claude call with the thinking indicator; failures become a retryable message.
   * If the learner cancels, `undo` puts back what they sent so they can edit it.
   */
  async function run(fn: (signal: AbortSignal) => Promise<void>, line = "Hmm, let me think…", undo?: () => void) {
    const prev = phase;
    const ctl = new AbortController();
    request = ctl;
    stalled = null;
    // The composer is about to be replaced or disabled; keep focus in the session so Esc still cancels.
    const hadFocus = !!rootEl?.contains(document.activeElement);
    phase = { p: "busy" };
    thinking = true;
    slow = false;
    const slowTimer = setTimeout(() => (slow = true), 8_000);
    store.say("thinking", line);
    void scrollDown();
    if (hadFocus) void tick().then(() => { if (rootEl && !rootEl.contains(document.activeElement)) rootEl.focus({ preventScroll: true }); });
    const retry = () => run(fn, line, undo);
    try {
      await fn(ctl.signal);
    } catch (e) {
      phase = prev;
      // Nothing to go back to (e.g. writing a quiz): offer to retry or skip instead of a dead "thinking" state.
      if (prev.p === "busy") stalled = retry;
      if ((ctl.signal.aborted || isCancel(e)) && undo) {
        undo();
        store.say("happy", "Okay, stopped. Take your time.");
      } else if (ctl.signal.aborted || isCancel(e)) {
        store.say("happy", "Okay, stopped.");
      } else {
        push({
          kind: "error",
          text: errText(e),
          retry,
          mood: "confused",
        });
        store.say("confused", "Oops, I couldn't reach my brain.");
      }
    } finally {
      clearTimeout(slowTimer);
      if (request === ctl) request = null;
      thinking = false;
      slow = false;
    }
  }

  function cancel() {
    request?.abort();
  }

  /** Remove the learner's last message and put its text back in the composer. */
  function unsend(id: number, text: string, taken: Img[], into: "draft" | "ask" = "draft") {
    msgs = msgs.filter((m) => m.id !== id);
    if (into === "ask") ask = text;
    else draft = text;
    images = taken;
    void focusInput();
  }

  // -------------------------------------------------------------------------
  // Steps

  function startStep(i: number) {
    stepIdx = i;
    draft = "";
    choice = null;
    mode = "answer";
    const step = steps[i];
    if (!step) return finish();
    if (step.kind === "explain") {
      const c = store.concept(step.conceptId);
      if (!c) return startStep(i + 1);
      touch(c.id);
      store.currentConceptId = c.id;
      draft = loadDraft(obsidianApp(), `explain:${c.id}`);
      push({ kind: "divider", text: `Explain · ${c.name}` });
      question = conceptQuestion(c);
      const intro = isNew(c)
        ? `**${question}**\n\nExplain it in your own words, as if to a curious 12-year-old: plain words, and if you need a technical term, explain it too. Your best guess is fine; that's how we find the gaps.`
        : `**${question}**\n\nYou've met this idea before. Explain it simply, in your own words, as if to someone who's never heard of it.`;
      push({ kind: "say", md: intro, mood: "curious", source: c.note_path });
      store.say("curious", isNew(c) ? "New idea! Teach it to me." : "Let's see if this one stuck.");
      phase = { p: "explain", conceptId: c.id, attempt: 0, peeked: false, gaps: [], lastExplanation: "", lastReteach: "" };
      void focusInput();
    } else {
      push({ kind: "divider", text: `Quiz · ${step.count} questions` });
      touch(...step.conceptIds);
      store.currentConceptId = null;
      // Not the previous step's phase: cancelling must not drop the learner back into a finished step.
      phase = { p: "busy" };
      void run(async (signal) => {
        const set = await api.makeQuiz(step.conceptIds, step.count, signal);
        if (!set.questions.length) throw "Claude didn't return any questions.";
        push({ kind: "say", md: set.mascot_line || "Pop quiz! No peeking at your notes.", mood: asMood(set.mood, "curious") });
        store.say(asMood(set.mood, "curious"), set.mascot_line);
        phase = { p: "quiz", questions: set.questions, idx: 0, stage: "answer" };
        showQuestion(set.questions, 0);
      }, "Sharpening my pencil… writing your questions.");
    }
  }

  function finish() {
    phase = { p: "done" };
    store.currentConceptId = null;
    push({ kind: "summary", mood: "celebrating" });
    const n = results.explained.filter((e) => e.passed).length;
    store.say("celebrating", n ? `Session done! You can now explain ${n} more thing${n > 1 ? "s" : ""}.` : "Session done! Great work.");
    void store.refresh();
  }

  function continueSession() {
    startStep(stepIdx + 1);
  }

  /** Insert steps right after the current one. */
  function insertSteps(...extra: Step[]) {
    steps.splice(stepIdx + 1, 0, ...extra);
  }

  // -------------------------------------------------------------------------
  // Explain (Feynman loop)

  function submitExplain(stuck = false) {
    if (phase.p !== "explain") return;
    const ph = phase;
    const text = draft.trim();
    if (!stuck && !text && !images.length) return;
    const img = stuck ? { inputs: [], urls: [], taken: [] } : takeImages();
    const sent = push({ kind: "me", text: stuck ? "I'm stuck. Can you teach me?" : text, images: img.urls });
    const kept = draft;
    // The stored draft is only cleared once Clawd has read it, so closing the view mid-request keeps it.
    draft = "";
    const c = store.concept(ph.conceptId);
    const asked = question;
    const followUp = stuck ? "" : turnPrompt;
    void run(
      async (signal) => {
        const ev = await api.evaluateExplanation({
          signal,
          followUp,
          conceptId: ph.conceptId,
          question: asked,
          explanation: text,
          attempt: ph.attempt,
          previousGaps: ph.gaps,
          peeked: ph.peeked,
          stuck,
          images: img.inputs,
        });
        saveDraft(obsidianApp(), `explain:${ph.conceptId}`, "");
        const mood: Mood = ev.passed ? "celebrating" : asMood(ev.mood, "encouraging");
        push({ kind: "feedback", ev, stuck, conceptId: ph.conceptId, mood });
        store.say(mood, ev.mascot_line);
        if (ph.attempt === 0) results.explained.push({ conceptId: ph.conceptId, name: c?.name ?? "", score: ev.score, passed: ev.passed });
        else if (ev.passed) {
          const r = results.explained.findLast((x) => x.conceptId === ph.conceptId);
          if (r) r.passed = true;
        }
        const next = {
          conceptId: ph.conceptId,
          attempt: ph.attempt + 1,
          gaps: ev.gaps,
          lastExplanation: text,
          lastReteach: ev.reteach,
        };
        phase = ev.passed ? { p: "explained", ...next } : { p: "explain", peeked: ph.peeked, ...next };
        void store.refresh();
        if (!ev.passed) void focusInput();
      },
      stuck ? "No worries. Let me teach it from scratch…" : "Reading your explanation carefully…",
      () => unsend(sent, kept, img.taken),
    );
  }

  /** The learner decides they understand (or already know) the concept and moves on. */
  function markUnderstood() {
    if (phase.p !== "explain") return;
    const ph = phase;
    const c = store.concept(ph.conceptId);
    const before = ph.attempt === 0;
    push({ kind: "me", text: before ? "I already know this one." : "I understand it now." });
    saveDraft(obsidianApp(), `explain:${ph.conceptId}`, "");
    void api.selfReport(ph.conceptId, before ? "known" : "understood");
    const r = results.explained.findLast((x) => x.conceptId === ph.conceptId);
    if (r) {
      r.passed = true;
      r.self = true;
    } else results.explained.push({ conceptId: ph.conceptId, name: c?.name ?? "", score: null, passed: true, self: true });
    push({
      kind: "say",
      md: before
        ? "Fair enough, skipping it for now. I'll bring it back in a later review to make sure it's solid."
        : "Great, moving on. I'll check this one again in a later review.",
      mood: "happy",
    });
    store.say("happy", before ? "Skipping. You know your stuff!" : "Onwards!");
    void store.refresh();
    continueSession();
  }

  function hint() {
    if (phase.p !== "explain") return;
    const c = store.concept(phase.conceptId);
    if (!c) return;
    phase.peeked = true;
    const quote = c.excerpt ? `\n\n> ${c.excerpt}` : "";
    push({ kind: "say", md: `**Hint from your notes:** ${c.summary}${quote}\n\nNow put it in your own words.`, mood: "encouraging" });
    store.say("encouraging", "A little nudge. Now make it yours!");
    void focusInput();
  }

  function explainAgain() {
    if (phase.p !== "explained") return;
    phase = { ...phase, p: "explain", peeked: true };
    push({ kind: "say", md: "Go for it: explain it once more, even more simply.", mood: "happy" });
    void focusInput();
  }

  function learnPrereq(id: number, fromConceptId: number) {
    if (thinking || (phase.p !== "explain" && phase.p !== "explained") || phase.conceptId !== fromConceptId) return;
    insertSteps({ kind: "explain", conceptId: id }, { kind: "explain", conceptId: phase.conceptId });
    continueSession();
  }

  // -------------------------------------------------------------------------
  // Quiz

  function showQuestion(questions: Question[], idx: number) {
    choice = null;
    confidence = null;
    needConfidence = false;
    activeQuestionId = push({ kind: "question", q: questions[idx], n: idx + 1, total: questions.length, answered: null, mood: "curious" });
    if (!isMcq(questions[idx])) void focusInput();
    else void tick().then(() => rootEl?.focus({ preventScroll: true }));
  }

  function isMcq(q: Question) {
    return q.kind === "mcq" && q.options.length > 0;
  }

  const currentQ = $derived(phase.p === "quiz" ? phase.questions[phase.idx] : null);

  function submitAnswer() {
    if (phase.p !== "quiz" || phase.stage !== "answer" || !currentQ) return;
    const ph = phase;
    const q = currentQ;
    const mcq = isMcq(q);
    if (mcq && choice === null) return;
    const text = draft.trim();
    if (!mcq && !text && !images.length) return;
    if (!confidence) {
      needConfidence = true;
      store.say("curious", "Before I check: how sure are you?");
      return;
    }
    const chosen = choice;
    const conf = confidence;
    const img = mcq ? { inputs: [], urls: [], taken: [] } : takeImages();
    const sent = push({
      kind: "me",
      text: mcq ? `${"ABCD"[chosen!] ?? chosen! + 1}. ${q.options[chosen!]}` : text,
      note: { guess: "Just guessing", unsure: "Not sure", sure: "Confident" }[conf],
      images: img.urls,
    });
    const kept = draft;
    draft = "";
    void run(async (signal) => {
      const out = await api.gradeAnswer(q, mcq ? chosen : null, text, conf, img.inputs, signal);
      const qm = msgs.findLast((m) => m.kind === "question");
      if (qm && qm.kind === "question" && mcq) qm.answered = chosen;
      const mood = asMood(out.grade.mood, out.grade.correct ? "happy" : "encouraging");
      push({ kind: "grade", g: out.grade, q, mood });
      store.say(mood, out.grade.mascot_line);
      results.quiz.push({ score: out.grade.score, correct: out.grade.correct });
      const needsCheck = !out.grade.correct && !!out.grade.check_question;
      phase = { ...ph, stage: needsCheck ? "check" : "graded", grade: out.grade, miscId: out.misconception_id };
      if (needsCheck) void focusInput();
      else void tick().then(() => rootEl?.focus({ preventScroll: true }));
      void store.refresh();
    }, "Checking your answer…", () => unsend(sent, kept, img.taken));
  }

  function submitCheck() {
    if (phase.p !== "quiz" || phase.stage !== "check" || !phase.grade) return;
    const ph = phase;
    const g = phase.grade;
    const text = draft.trim();
    if (!text && !images.length) return;
    const img = takeImages();
    const sent = push({ kind: "me", text, images: img.urls });
    const kept = draft;
    draft = "";
    void run(async (signal) => {
      const r = await api.checkAnswer({
        signal,
        question: g.check_question,
        key: g.check_answer,
        misconception: g.misconception,
        answer: text,
        misconceptionId: ph.miscId ?? null,
        images: img.inputs,
      });
      const mood = asMood(r.mood, r.understood ? "proud" : "encouraging");
      push({ kind: "check", r, mood });
      store.say(mood, r.mascot_line);
      phase = { ...ph, stage: "checked" };
      void store.refresh();
    }, "Did it click? Let's see…", () => unsend(sent, kept, img.taken));
  }

  function nextQuestion() {
    if (phase.p !== "quiz") return;
    const idx = phase.idx + 1;
    if (idx < phase.questions.length) {
      phase = { ...phase, idx, stage: "answer", grade: undefined, miscId: null };
      showQuestion(phase.questions, idx);
    } else {
      const total = phase.questions.length;
      const right = results.quiz.slice(-total).filter((r) => r.correct).length;
      const mood: Mood = right === total ? "celebrating" : right >= total / 2 ? "happy" : "encouraging";
      push({
        kind: "say",
        md: `**Quiz done: ${right} of ${total} correct.** ${right === total ? "Flawless!" : "Anything you missed is logged, and I'll bring it back until it sticks."}`,
        mood,
      });
      store.say(mood);
      continueSession();
    }
  }

  function explainNext(q: Question) {
    const c = store.concept(q.concept_id);
    if (!c) return;
    insertSteps({ kind: "explain", conceptId: c.id });
    store.say("happy", `Added "${c.name}" to this session. We'll do it right after the quiz.`);
  }

  // -------------------------------------------------------------------------
  // Ask Clawd

  function situation(): { conceptId: number | null; text: string } {
    const ph = phase.p === "busy" && resume ? resume : phase;
    if (ph.p === "explain" || ph.p === "explained") {
      const c = store.concept(ph.conceptId);
      return {
        conceptId: ph.conceptId,
        text:
          `Feynman session on "${c?.name}". The learner was asked: "${question}"` +
          (ph.lastExplanation ? `\nLearner's latest explanation:\n${ph.lastExplanation}` : "") +
          (ph.lastReteach ? `\nYour latest re-explanation:\n${ph.lastReteach}` : ""),
      };
    }
    if (ph.p === "quiz") {
      const q = ph.questions[ph.idx];
      return {
        conceptId: q.concept_id,
        text: `Quiz question: ${q.question}\nAnswer key: ${q.answer}` + (ph.grade ? `\nYour grading feedback: ${ph.grade.feedback}` : ""),
      };
    }
    return { conceptId: null, text: "General study session." };
  }

  function sendAsk() {
    const message = ask.trim();
    if ((!message && !images.length) || phase.p === "busy") return;
    const s = situation();
    const img = takeImages();
    const sent = push({ kind: "me", text: message, images: img.urls });
    const kept = ask;
    ask = "";
    const history = [...chat];
    const back = phase;
    void run(async (signal) => {
      const r = await api.askTutor(s.conceptId, s.text, history, message, img.inputs, signal);
      chat.push([true, message + (img.urls.length ? " [attached an image]" : "")], [false, r.reply]);
      const mood = asMood(r.mood, "happy");
      push({ kind: "say", md: r.reply, mood });
      store.say(mood, r.mascot_line);
      phase = back;
    }, "Good question! Thinking…", () => unsend(sent, kept, img.taken, "ask"));
  }

  // -------------------------------------------------------------------------
  // Keyboard

  function primary() {
    if (mode === "ask") return sendAsk();
    switch (phase.p) {
      case "explain":
        return submitExplain();
      case "explained":
        return continueSession();
      case "quiz":
        if (phase.stage === "answer") return submitAnswer();
        if (phase.stage === "check") return submitCheck();
        return nextQuestion();
    }
  }

  function onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      // Don't let Obsidian's own Mod+Enter hotkey fire too.
      e.preventDefault();
      e.stopPropagation();
      primary();
      return;
    }
    if (e.key === "Escape" && thinking) {
      e.preventDefault();
      cancel();
      return;
    }
    if (typing || mode === "ask") return;
    if (phase.p === "quiz" && phase.stage === "answer" && currentQ && isMcq(currentQ)) {
      const n = Number(e.key);
      const conf = CONFIDENCE.find(([, , key]) => key === e.key.toLowerCase());
      if (n >= 1 && n <= currentQ.options.length) {
        choice = n - 1;
        e.preventDefault();
        e.stopPropagation();
      } else if (conf) {
        setConfidence(conf[0]);
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === "Enter" && choice !== null) {
        e.preventDefault();
        // Enter on a focused option or confidence radio picks it first, so the submit uses what's focused.
        const t = e.target as HTMLElement | null;
        if (t?.getAttribute("role") === "radio" && rootEl?.contains(t)) t.click();
        submitAnswer();
      }
    } else if (e.key === "Enter" && (phase.p === "explained" || (phase.p === "quiz" && (phase.stage === "graded" || phase.stage === "checked")))) {
      e.preventDefault();
      primary();
    }
  }

  const CONFIDENCE: [Confidence, string, string][] = [
    ["guess", "Guessing", "g"],
    ["unsure", "Unsure", "u"],
    ["sure", "Confident", "c"],
  ];

  function setConfidence(c: Confidence) {
    confidence = c;
    needConfidence = false;
  }

  /** Arrow keys move between the confidence options, like native radios. */
  function confidenceKey(e: KeyboardEvent) {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    // currentTarget is null once the event has finished dispatching, so take it now.
    const group = e.currentTarget as HTMLElement;
    const i = CONFIDENCE.findIndex(([id]) => id === confidence);
    const next = CONFIDENCE[(i + dir + CONFIDENCE.length) % CONFIDENCE.length][0];
    setConfidence(next);
    void tick().then(() => group.querySelector<HTMLElement>("[aria-checked=true]")?.focus());
  }

  function end() {
    if (phase.p === "done") store.endSession();
    else void store.requestEnd();
  }

  const live = {
    unfinished: () => phase.p !== "done" && (stepIdx > 0 || msgs.some((m) => m.kind === "me") || !!draft.trim() || !!ask.trim()),
    describe: () => {
      const answered = msgs.filter((m) => m.kind === "me").length;
      return `You're on step ${Math.min(stepIdx + 1, steps.length)} of ${steps.length}` + (answered ? ` with ${answered} answer${answered > 1 ? "s" : ""} so far` : "");
    },
    addExplain: (conceptId: number) => {
      if (phase.p === "done") {
        steps.push({ kind: "explain", conceptId });
        startStep(steps.length - 1);
      } else insertSteps({ kind: "explain", conceptId });
    },
  };

  onMount(() => {
    store.primaryHandlers.session = primary;
    store.session = live;
    startStep(0);
    return () => {
      request?.abort();
      if (store.primaryHandlers.session === primary) delete store.primaryHandlers.session;
      if (store.session === live) store.session = null;
    };
  });

  // Keep an unsent explanation if the view closes.
  $effect(() => {
    if (phase.p === "explain") saveDraft(obsidianApp(), `explain:${phase.conceptId}`, draft);
  });

  // Remember what we were doing while a request is in flight (for Ask context).
  $effect(() => {
    if (phase.p !== "busy") resume = phase;
  });

  const explainPhase = $derived(phase.p === "explain" ? phase : null);
  /** Clawd's latest "your turn" / stretch question for the concept being explained. */
  const turnPrompt = $derived.by(() => {
    if (!explainPhase || explainPhase.attempt === 0) return "";
    const fb = msgs.findLast((m) => m.kind === "feedback" && m.conceptId === explainPhase.conceptId);
    // After a pass, next_prompt is a stretch question, not what "explain once more" asks for.
    return fb?.kind === "feedback" && !fb.ev.passed ? fb.ev.next_prompt.trim() : "";
  });
  const canAsk = $derived(phase.p !== "done");
  const isLast = $derived(stepIdx >= steps.length - 1);
  const stepLabel = $derived.by(() => {
    if (phase.p === "done") return "Done";
    const s = steps[stepIdx];
    if (!s) return "";
    return `Step ${stepIdx + 1} of ${steps.length} · ${s.kind === "explain" ? "Explain" : "Quiz"}`;
  });
  /** Concepts this session touched, with mastery before and now. */
  const progressRows = $derived(
    touched
      .map((id) => ({ c: store.concept(id), from: before.get(id) ?? 0 }))
      .filter((r): r is { c: NonNullable<typeof r.c>; from: number } => !!r.c && !!r.c.last_reviewed),
  );
  const shaky = $derived(progressRows.filter((r) => masteryLevel(r.c) === "shaky").map((r) => r.c.id));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="session" tabindex="-1" bind:this={rootEl} onkeydown={onKey}>
  <header class="top">
    <div class="title">
      <h2>{plan.title}</h2>
      <div class="steps" role="list" aria-label="Session progress">
        {#each steps as s, i}
          <span
            role="listitem"
            aria-label={`${s.kind === "explain" ? `Explain: ${store.concept(s.conceptId)?.name ?? ""}` : `Quiz (${s.count} questions)`}${i < stepIdx || phase.p === "done" ? ", done" : i === stepIdx ? ", current" : ""}`}
            class="step"
            class:done={i < stepIdx || phase.p === "done"}
            class:now={i === stepIdx && phase.p !== "done"}
            title={s.kind === "explain" ? `Explain: ${store.concept(s.conceptId)?.name ?? ""}` : `Quiz (${s.count} questions)`}
          >
            <Icon name={s.kind === "explain" ? "brain" : "zap"} size={13} />
          </span>
        {/each}
      </div>
      <span class="step-label faint small">{stepLabel}</span>
    </div>
    <div class="top-actions">
      <div class="ct-composer-settings wide-only"><ModelPicker /></div>
      <button class="btn ghost sm" onclick={end}>{phase.p === "done" ? "Close" : "End session"}</button>
    </div>
  </header>

  <div class="thread" bind:this={threadEl}>
    <div class="col">
      {#each msgs as m (m.id)}
        {#if m.kind === "divider"}
          <div class="divider"><span>{m.text}</span></div>
        {:else if m.kind === "me"}
          <div class="me">
            <div class="bubble mine">
              {#if m.images?.length}<div class="mine-imgs"><Thumbs images={m.images.map((url) => ({ url }))} size={96} /></div>{/if}
              {#if m.text}<Markdown md={m.text} />{/if}
              {#if m.note}<small>{m.note}</small>{/if}
            </div>
          </div>
        {:else}
          <div class="clawd-row" data-msg={m.id}>
            <div class="avatar">
              <Clawd mood={m.id === lastClawd && !thinking ? store.liveMood : m.mood} size={40} animate={m.id === lastClawd && !thinking} follow={false} />
            </div>
            <div class="bubble ct-card" class:err={m.kind === "error"}>
              {#if m.kind === "say"}
                <Markdown md={m.md} />
                {#if m.source}
                  <button class="source" onclick={() => store.openNote(m.source!)}>
                    <Icon name="book" size={14} />{store.noteTitle(m.source)}
                  </button>
                {/if}
              {:else if m.kind === "feedback"}
                <FeedbackCard
                  ev={m.ev}
                  stuck={m.stuck}
                  latest={m.id === lastClawd}
                  interactive={!thinking && (phase.p === "explain" || phase.p === "explained") && phase.conceptId === m.conceptId}
                  conceptId={m.conceptId}
                  onprereq={(id) => learnPrereq(id, m.conceptId)}
                />
              {:else if m.kind === "question"}
                <QuestionCard
                  q={m.q}
                  n={m.n}
                  total={m.total}
                  choice={m.id === activeQuestionId ? choice : null}
                  answered={m.answered}
                  interactive={m.id === activeQuestionId && phase.p === "quiz" && phase.stage === "answer" && mode === "answer"}
                  onchoose={(i) => (choice = i)}
                />
              {:else if m.kind === "grade"}
                <GradeCard g={m.g} q={m.q} latest={m.id === lastClawd} onexplain={() => explainNext(m.q)} />
              {:else if m.kind === "check"}
                <div class="checked">
                  <span class="pill {m.r.understood ? 'ok' : 'notyet'}">{m.r.understood ? "Got it" : "Not yet"}</span>
                  <Markdown md={m.r.feedback} />
                </div>
              {:else if m.kind === "error"}
                <div class="error">
                  <p><b>I couldn't reach Claude.</b></p>
                  <p class="muted small">{m.text}</p>
                  {#if m.id === lastClawd}
                    <button class="btn sm" onclick={() => { msgs = msgs.filter((x) => x.id !== m.id); m.retry(); }}><Icon name="retry" size={15} />Try again</button>
                  {/if}
                </div>
              {:else if m.kind === "summary"}
                <div class="summary">
                  <h3>Session complete</h3>
                  {#if results.explained.length}
                    <p class="sec-title">Explained</p>
                    <ul>
                      {#each results.explained as r}
                        <li>
                          <Ring value={(r.score ?? 70) / 100} size={22} width={3} color={r.score === null ? "var(--text-3)" : scoreColor(r.score)} />
                          <span><Markdown md={r.name} inline /></span>
                          <span class="faint small">{r.self ? "marked as understood by you" : r.passed ? "nailed it" : "keep practicing"}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  {#if results.quiz.length}
                    <p class="sec-title">Quiz</p>
                    <p>{results.quiz.filter((r) => r.correct).length} of {results.quiz.length} correct</p>
                  {/if}
                  {#if progressRows.length}
                    <p class="sec-title">Mastery</p>
                    <ul class="mastery">
                      {#each progressRows as r (r.c.id)}
                        {@const delta = Math.round((r.c.mastery - r.from) * 100)}
                        <li>
                          <Ring value={r.c.mastery} size={22} width={3} color={masteryColor(r.c)} />
                          <span class="m-name"><Markdown md={r.c.name} inline /></span>
                          <span class="small" class:up={delta > 0} class:down={delta < 0}>
                            {Math.round(r.from * 100)}% → {Math.round(r.c.mastery * 100)}%
                          </span>
                          <span class="faint small">next review {relativeDue(r.c)}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <p class="muted small">Clawd scheduled your next reviews. Concepts you struggled with come back sooner.</p>
                  {#if shaky.length}
                    <button class="btn sm" onclick={() => store.startQuiz("Shaky concepts", shaky, Math.min(6, Math.max(3, shaky.length * 2)))}>
                      <Icon name="zap" size={15} />Quiz the {shaky.length} shaky one{shaky.length > 1 ? "s" : ""} now
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
      {#if thinking}
        <div class="clawd-row thinking-row" aria-live="polite">
          <div class="avatar"><Clawd mood="thinking" size={40} follow={false} /></div>
          <div class="bubble ct-card typing" aria-label="Clawd is thinking"><span></span><span></span><span></span></div>
          {#if slow}<p class="slow faint small">Still thinking… long notes and higher effort take a little longer.</p>{/if}
        </div>
      {/if}
    </div>
  </div>

  <footer class="composer">
    <div class="col">
      {#if canAsk}
        <div class="modes">
          <button class:sel={mode === "answer"} onclick={() => { mode = "answer"; void focusInput(); }}>Answer</button>
          <button class:sel={mode === "ask"} onclick={() => (mode = "ask")}><Icon name="chat" size={14} />Ask Clawd</button>
        </div>
      {/if}

      {#if phase.p === "busy"}
        {#if thinking}
          <div class="busy-row">
            <span class="muted small">{slow ? "Still thinking…" : "Clawd is thinking…"}</span>
            <button class="btn sm" onclick={cancel} title="Stop this request (Esc)"><Icon name="x" size={14} />Cancel</button>
          </div>
        {:else}
          <div class="busy-row">
            <span class="muted small">Stopped before this step was ready.</span>
            <span class="row-actions">
              <button class="btn sm ghost" onclick={() => { stalled = null; continueSession(); }}>Skip this step</button>
              <button class="btn sm" disabled={!stalled} onclick={() => { msgs = msgs.filter((x) => !(x.kind === "error" && x.id === lastClawd)); stalled?.(); }}><Icon name="retry" size={14} />Try again</button>
            </span>
          </div>
        {/if}
      {:else if mode === "ask" && canAsk}
        <form class="ask" onsubmit={(e) => { e.preventDefault(); sendAsk(); }} onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()}>
          <div class="ct-composer">
            {#if images.length}<div class="box-imgs"><Thumbs {images} onremove={(i) => (images = images.filter((_, j) => j !== i))} /></div>{/if}
            <textarea
              class="ask-input"
              rows="1"
              bind:value={ask}
              aria-label="Ask Clawd"
              placeholder="Ask anything, e.g. “why does that matter?” or “give me another example”"
              onkeydown={(e) => enterToSend(e, sendAsk)}
            ></textarea>
            <div class="ct-composer-actions">
              <AttachButton bind:this={attacher} bind:images />
              <span class="ct-composer-hint">{SEND_HINT}</span>
              <SendButton label="Send message" type="submit" disabled={!ask.trim() && !images.length} />
            </div>
          </div>
        </form>
      {:else if explainPhase}
        {#if explainPhase.attempt >= 3}
          <p class="nudge">
            <Icon name="flag" size={14} />You've worked hard on this one. If it makes sense now, click <b>I understand now</b> to
            move on; it'll come back in a later review either way.
          </p>
        {/if}
        {#if turnPrompt}
          <p class="turn" id="turn-prompt"><Icon name="chat" size={14} /><span><b>Your turn:</b> <Markdown md={turnPrompt} inline /></span></p>
        {/if}
        <div class="box ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
          {#if images.length}<div class="box-imgs"><Thumbs {images} onremove={(i) => (images = images.filter((_, j) => j !== i))} /></div>{/if}
          <textarea
            bind:this={inputEl}
            bind:value={draft}
            rows="2"
            aria-label="Your explanation"
            aria-describedby={turnPrompt ? "turn-prompt" : undefined}
            placeholder={turnPrompt ? "Answer Clawd's prompt above…" : explainPhase.attempt ? "Explain it again, fixing the gaps…" : "Your explanation, in your own words…"}
            onkeydown={(e) => enterToSend(e, () => submitExplain())}
          ></textarea>
          <div class="ct-composer-actions">
            <AttachButton bind:this={attacher} bind:images />
            <span class="ct-composer-hint">{SEND_HINT}</span>
            <SendButton label={explainPhase.attempt ? "Explain again" : "Submit"} disabled={!draft.trim() && !images.length} onclick={() => submitExplain()} />
          </div>
        </div>
        <div class="ct-composer-footer">
          <div class="ct-composer-options">
            {#if explainPhase.attempt === 0 && !explainPhase.peeked}
              <button class="btn ghost sm" onclick={hint}><Icon name="eye" size={15} />Hint</button>
            {/if}
            <button class="btn ghost sm self" class:confused={explainPhase.attempt > 0} onclick={() => submitExplain(true)}
              ><Icon name="help" size={15} />{explainPhase.attempt ? "Still confused" : "I'm stuck"}</button
            >
            <button
              class="btn ghost sm self understood"
              title={explainPhase.attempt ? "Move on: I've got it now" : "Skip: I already know this"}
              onclick={markUnderstood}
              ><Icon name="check" size={15} />{explainPhase.attempt ? "I understand now" : "I know this"}</button
            >
          </div>
        </div>
      {:else if phase.p === "explained"}
        <div class="row-actions">
          <button class="btn ghost" onclick={explainAgain}>Explain once more</button>
          <button class="btn primary lg" onclick={continueSession}>{isLast ? "Finish session" : "Continue"}<Icon name="arrow" size={16} /></button>
        </div>
      {:else if phase.p === "quiz" && currentQ}
        {#if phase.stage === "answer"}
          {#if !isMcq(currentQ)}
            <div class="box ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
              {#if images.length}<div class="box-imgs"><Thumbs {images} onremove={(i) => (images = images.filter((_, j) => j !== i))} /></div>{/if}
              <textarea
                bind:this={inputEl}
                bind:value={draft}
                rows="2"
                aria-label="Your answer"
                placeholder="Your answer… (or attach a photo of your working)"
                onkeydown={(e) => enterToSend(e, submitAnswer)}
              ></textarea>
              <div class="ct-composer-actions">
                <AttachButton bind:this={attacher} bind:images />
                <span class="ct-composer-hint">{SEND_HINT}</span>
                <SendButton label="Submit" disabled={!draft.trim() && !images.length} onclick={submitAnswer} />
              </div>
            </div>
          {/if}
          <div class="ct-composer-footer">
            <span class="faint small" id="conf-label">How sure?</span>
            <div class="conf" class:need={needConfidence} role="radiogroup" aria-labelledby="conf-label" tabindex="-1" onkeydown={confidenceKey}>
              {#each CONFIDENCE as [id, label, key], i}
                <button
                  role="radio"
                  aria-checked={confidence === id}
                  tabindex={confidence === id || (!confidence && i === 0) ? 0 : -1}
                  class:sel={confidence === id}
                  onclick={() => setConfidence(id)}
                  >{label}{#if isMcq(currentQ)}<kbd>{key.toUpperCase()}</kbd>{/if}</button
                >
              {/each}
            </div>
            {#if needConfidence}<span class="need-text small" role="status">Pick one to submit</span>{/if}
            {#if isMcq(currentQ)}
              <SendButton label="Submit" disabled={choice === null} onclick={submitAnswer} />
            {/if}
          </div>
        {:else if phase.stage === "check"}
          <div class="box ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
            {#if images.length}<div class="box-imgs"><Thumbs {images} onremove={(i) => (images = images.filter((_, j) => j !== i))} /></div>{/if}
            <textarea
              bind:this={inputEl}
              bind:value={draft}
              rows="2"
              aria-label="Your answer to the quick check"
              placeholder="Answer the quick check…"
              onkeydown={(e) => enterToSend(e, submitCheck)}
            ></textarea>
            <div class="ct-composer-actions">
              <AttachButton bind:this={attacher} bind:images />
              <span class="ct-composer-hint">{SEND_HINT}</span>
              <SendButton label="Check" disabled={!draft.trim() && !images.length} onclick={submitCheck} />
            </div>
          </div>
          <div class="ct-composer-footer">
            <div class="ct-composer-options">
              <button class="btn ghost sm" title="Skip the check and go to the next question" onclick={nextQuestion}
                ><Icon name="check" size={15} />I understand, next</button
              >
            </div>
          </div>
        {:else}
          <div class="row-actions">
            <button class="btn primary lg" onclick={nextQuestion}>
              {phase.idx + 1 < phase.questions.length ? "Next question" : isLast ? "Finish" : "Continue"}<Icon name="arrow" size={16} />
            </button>
          </div>
        {/if}
      {:else if phase.p === "done"}
        <div class="row-actions">
          <button class="btn" onclick={end}>Back to Today</button>
          <button class="btn primary lg" onclick={() => store.startStudy()}>Keep going<Icon name="arrow" size={16} /></button>
        </div>
      {/if}
      <!-- Narrow panes have no room in the header, so the model and effort switches sit under the entry box. -->
      <div class="ct-composer-footer model-row"><div class="ct-composer-settings"><ModelPicker /></div></div>
    </div>
  </footer>
</div>

<style>
  .session {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .col {
    width: 100%;
    max-width: 780px;
    margin: 0 auto;
    padding: 0 20px;
  }
  .top {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }
  .title h2 {
    font-size: 1rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .steps {
    display: flex;
    gap: 6px;
  }
  .step {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .step.now {
    background: var(--accent);
    color: var(--accent-text);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .step.done {
    background: var(--good-soft);
    color: var(--good);
  }

  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 0 12px;
  }
  .thread .col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 8px 0 -4px;
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .clawd-row {
    scroll-margin-top: 16px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    animation: rise 0.25s ease-out;
  }
  .avatar {
    width: 44px;
    flex: none;
    display: flex;
    justify-content: center;
    padding-top: 2px;
  }
  .bubble {
    padding: 16px 18px;
    border-radius: 4px var(--r-lg) var(--r-lg) var(--r-lg);
    min-width: 0;
    flex: 1;
  }
  .bubble.err {
    border-color: var(--bad);
  }
  .me {
    display: flex;
    justify-content: flex-end;
    animation: rise 0.2s ease-out;
  }
  .mine {
    flex: none;
    max-width: min(560px, 85%);
    background: var(--accent-soft);
    border-radius: var(--r-lg) 4px var(--r-lg) var(--r-lg);
    padding: 10px 14px;
    white-space: pre-wrap;
  }
  .mine small {
    display: block;
    color: var(--text-3);
    font-size: 0.76rem;
    margin-top: 2px;
  }
  .typing {
    flex: none;
    display: flex;
    gap: 5px;
    padding: 16px 18px;
  }
  .typing span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    animation: dot 1.2s infinite;
  }
  .typing span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing span:nth-child(3) {
    animation-delay: 0.3s;
  }
  .checked {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  .pill.ok {
    color: var(--good);
    background: var(--good-soft);
  }
  .pill.notyet {
    color: var(--warn);
    background: var(--warn-soft);
  }
  .error {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .summary ul {
    list-style: none;
    padding: 0;
    margin: 0 0 6px;
    display: grid;
    gap: 6px;
  }
  .summary li {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .composer {
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--bg);
    padding: 10px 0 16px;
  }
  .modes {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .modes button {
    display: flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: none;
    color: var(--text-3);
    font-size: 0.82rem;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 99px;
    cursor: pointer;
  }
  .modes button.sel {
    background: var(--surface-2);
    color: var(--text);
  }
  .turn {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0 4px 8px;
    padding: 8px 12px;
    border-left: 3px solid var(--accent);
    background: var(--accent-soft);
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    font-size: 0.9em;
    max-height: 6.5em;
    overflow-y: auto;
  }
  .turn :global(svg) {
    flex: none;
    margin-top: 3px;
    color: var(--accent);
  }
  .busy-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .thinking-row {
    flex-wrap: wrap;
  }
  .slow {
    flex-basis: 100%;
    padding-left: 54px;
  }
  .top-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .step-label {
    white-space: nowrap;
  }
  .mastery li {
    flex-wrap: wrap;
  }
  .m-name {
    flex: 1;
    min-width: 0;
  }
  .up {
    color: var(--good);
  }
  .down {
    color: var(--bad);
  }
  .need-text {
    color: var(--bad);
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .conf {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .conf.need {
    outline: 2px solid var(--bad-soft);
    outline-offset: 3px;
    border-radius: 99px;
  }
  .conf button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    background: none;
    border-radius: 99px;
    padding: 4px 12px;
    font-size: 0.85rem;
    cursor: pointer;
    color: var(--text-2);
  }
  .conf button.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .composer .model-row {
    display: none;
  }
  @container (max-width: 560px) {
    .step-label,
    .wide-only {
      display: none;
    }
    .composer .model-row {
      display: flex;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @keyframes dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-3px);
    }
  }
  .box-imgs {
    padding: 10px 10px 0;
  }
  .mine-imgs {
    margin-bottom: 6px;
  }
  .nudge {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85em;
    color: var(--text-2);
    margin: 0 0 8px 4px;
  }
  .nudge :global(.icon) {
    color: var(--accent);
    flex: none;
  }
  /* Self-report buttons stay quiet until you reach for them. */
  .self {
    opacity: 0.55;
    transition:
      opacity 0.12s,
      background 0.12s;
  }
  .self:hover,
  .self:focus-visible {
    opacity: 1;
  }
  .confused {
    color: var(--bad);
  }
  .confused:hover:not(:disabled) {
    color: var(--bad);
    background: var(--bad-soft);
  }
  .understood {
    color: var(--good);
  }
  .understood:hover:not(:disabled) {
    color: var(--good);
    background: var(--good-soft);
  }
  .session:focus {
    outline: none;
  }
  .source {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    font-size: 0.85em;
    color: var(--text-2);
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 99px;
  }
  .source:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .mine :global(.ct-md > :first-child) {
    margin-top: 0;
  }
  .mine :global(.ct-md > :last-child) {
    margin-bottom: 0;
  }
  @container (max-width: 560px) {
    .steps {
      display: none;
    }
    .col {
      padding: 0 12px;
    }
  }
</style>
