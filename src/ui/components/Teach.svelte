<!--
  Teach: ask for any topic and Clawd runs a Socratic lesson. It explains in small
  steps and keeps asking you to reason things out, instead of handing over answers.
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, asMood, errText, isCancel, obsidianApp, type Mood } from "../lib/api";
  import { enterToSend, loadDraft, saveDraft, SEND_HINT } from "../lib/util";
  import { store } from "../lib/store.svelte";
  import { TEACH_CONTROLS } from "../../core/tutor";
  import { Attachments } from "../lib/attachments.svelte";
  import { imageFiles, toInputs } from "../lib/images";
  import Clawd from "./Clawd.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import AttachButton from "./AttachButton.svelte";
  import SendButton from "./SendButton.svelte";
  import Thumbs from "./Thumbs.svelte";

  type Msg =
    | { id: number; from: "me"; text: string; images?: string[] }
    | { id: number; from: "clawd"; md: string; mood: Mood }
    /** `retry` is dropped once anything newer is sent: re-running it then would answer out of turn. */
    | { id: number; from: "error"; text: string; retry: (() => void) | null };

  /** Unsent text in the topic box survives the view closing, like explanation drafts. */
  const TOPIC_DRAFT = "teach:topic";
  let topic = $state(loadDraft(obsidianApp(), TOPIC_DRAFT));
  let started = $state(false);
  let msgs = $state<Msg[]>([]);
  let busy = $state(false);
  let starting = $state(false);
  let draft = $state("");
  /** Images for the message being composed (the topic box's, then the lesson's). */
  const att = new Attachments();
  let progress = $state(0);
  let stepTitle = $state("");
  let stage = $state<"intro" | "teaching" | "checking" | "wrap_up">("intro");
  let summary = $state("");
  let sources = $state<string[]>([]);
  let savedPath = $state<string | null>(null);
  let threadEl = $state<HTMLDivElement>();
  let inputEl = $state<HTMLTextAreaElement>();
  let rootEl = $state<HTMLDivElement>();
  let history = $state<[boolean, string][]>([]);
  let nextId = 1;
  // Bumped on reset so a save still in flight can't mark the next lesson as saved.
  let lesson = 0;
  let saving = $state(false);
  let request: AbortController | null = null;
  let slow = $state(false);

  const lastClawd = $derived([...msgs].reverse().find((m) => m.from === "clawd")?.id);
  const done = $derived(stage === "wrap_up");
  const waiting = $derived(busy || starting);
  /** Anything that sends waits for Clawd, and for images still being prepared. */
  const held = $derived(waiting || att.preparing > 0);

  const suggestions = $derived(
    [...store.weakConcepts(), ...store.dueConcepts()]
      .map((c) => c.name)
      .filter((n, i, a) => a.indexOf(n) === i)
      .slice(0, 5),
  );

  async function scrollDown() {
    await tick();
    threadEl?.scrollTo({ top: threadEl.scrollHeight, behavior: "smooth" });
  }

  function push(m: Omit<Msg, "id"> & Record<string, unknown>) {
    msgs.push({ ...(m as Msg), id: nextId++ });
    void scrollDown();
  }

  /** Send one turn: the learner's text (or a button's control message) plus any images. */
  async function send(text: string, shown: string, control = "") {
    if (held) return;
    const taken = att.take();
    const imgs = toInputs(taken);
    const sentId = nextId;
    if (shown || taken.length) push({ from: "me", text: shown, images: taken.map((i) => i.url) });
    const message = [control, text].filter(Boolean).join("\n\n");
    const histText = (shown || text) + (taken.length ? " [attached an image]" : "");
    const turn = async () => {
      if (busy || starting) return;
      for (const m of msgs) if (m.from === "error") m.retry = null;
      // The composer gets disabled while Clawd thinks; keep focus in the view so Esc still cancels.
      const hadFocus = !!rootEl?.contains(document.activeElement);
      busy = true;
      slow = false;
      const ctl = new AbortController();
      request = ctl;
      const slowTimer = setTimeout(() => (slow = true), 8_000);
      if (hadFocus) void tick().then(() => { if (rootEl && !rootEl.contains(document.activeElement)) rootEl.focus({ preventScroll: true }); });
      store.say("thinking", "Hmm, let me think about how to put this…");
      try {
        const r = await api.teach(topic, $state.snapshot(sources), $state.snapshot(history), message, imgs, ctl.signal);
        history.push([true, histText], [false, r.reply]);
        const mood = asMood(r.mood, r.stage === "wrap_up" ? "celebrating" : "curious");
        push({ from: "clawd", md: r.reply, mood });
        store.say(mood, r.mascot_line);
        progress = Math.max(progress, Math.min(100, r.progress));
        stepTitle = r.step_title;
        stage = r.stage;
        if (r.stage === "wrap_up") {
          summary = r.summary;
          progress = 100;
        }
      } catch (e) {
        if (ctl.signal.aborted || isCancel(e)) {
          // Put back what was sent so it can be edited. Control buttons (hint, show…) just vanish.
          msgs = msgs.filter((m) => m.id !== sentId);
          if (!control) draft = text;
          att.restore(taken);
          if (!history.length) {
            // Cancelled the very first turn: back to the topic box.
            started = false;
            msgs = [];
          }
          store.say("happy", "Okay, stopped.");
        } else {
          push({ from: "error", text: errText(e), retry: turn });
          store.say("confused", "Oops, I couldn't reach my brain.");
        }
      } finally {
        clearTimeout(slowTimer);
        if (request === ctl) request = null;
        slow = false;
        busy = false;
        if (!done) void tick().then(() => inputEl?.focus());
      }
    };
    await turn();
  }

  async function start(t = topic) {
    if (started || held) return;
    topic = t.trim();
    if (!topic && !att.images.length) return;
    if (!topic) topic = "the problem in my image";
    started = true;
    saveDraft(obsidianApp(), TOPIC_DRAFT, "");
    starting = true;
    try {
      sources = await api.relevantNotes(topic);
      starting = false;
      await send(topic, topic, TEACH_CONTROLS.start);
    } catch (e) {
      started = false;
      store.error = errText(e);
    } finally {
      starting = false;
    }
  }

  function submit() {
    const text = draft.trim();
    if ((!text && !att.images.length) || held || done) return;
    draft = "";
    void send(text, text);
  }

  function control(kind: "hint" | "show" | "next" | "wrap") {
    const shown = { hint: "Hint, please.", show: "Show me.", next: "I get it. Next step.", wrap: "Let's wrap up." }[kind];
    void send("", shown, TEACH_CONTROLS[kind]);
  }

  async function save() {
    if (saving) return;
    const id = lesson;
    saving = true;
    try {
      const path = await api.saveLesson(topic, summary, $state.snapshot(sources));
      if (id !== lesson) return;
      savedPath = path;
      store.say("proud", "Saved to your vault! Future you says thanks.");
    } catch (e) {
      if (id === lesson) store.error = `Couldn't save the lesson: ${errText(e)}`;
    } finally {
      if (id === lesson) saving = false;
    }
  }

  function cancel() {
    request?.abort();
  }

  /** Start over, asking first if that would throw away a lesson in progress or an unsaved note. */
  async function newLesson() {
    if (busy || starting) return;
    const unsaved = done && !!summary && !savedPath;
    const inProgress = !done && msgs.some((m) => m.from === "me");
    if (unsaved || inProgress) {
      const pick = await store.confirm(
        unsaved ? "Your study note isn't saved" : "Start a new lesson?",
        unsaved
          ? "Starting a new lesson clears this one, including the study note Clawd wrote for you."
          : "This conversation will be cleared. Lessons aren't saved until you wrap up and save the note.",
        [
          { id: "keep", label: unsaved ? "Go back" : "Keep going" },
          ...(unsaved ? [{ id: "save", label: "Save, then start new" }] : []),
          { id: "new", label: "Start new", danger: true, primary: !unsaved },
        ],
      );
      if (pick === "save") {
        await save();
        if (!savedPath) return;
      } else if (pick !== "new") return;
    }
    reset();
  }

  function reset() {
    if (busy || starting) return;
    lesson++;
    saving = false;
    topic = "";
    started = false;
    msgs = [];
    history = [];
    progress = 0;
    stepTitle = "";
    stage = "intro";
    summary = "";
    sources = [];
    savedPath = null;
    draft = "";
    att.clear();
  }

  function onPaste(e: ClipboardEvent) {
    const files = imageFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void att.add(files);
    }
  }

  function onDrop(e: DragEvent) {
    const files = imageFiles(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      void att.add(files);
    }
  }

  function primary() {
    if (!started) void start();
    else submit();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      primary();
    }
  }

  // Keep what's typed in the topic box if the view closes. Once the lesson starts it's sent;
  // a failed or cancelled start puts the box back, and this saves it again.
  $effect(() => {
    if (!started) saveDraft(obsidianApp(), TOPIC_DRAFT, topic);
  });

  onMount(() => {
    store.primaryHandlers.teach = primary;
    return () => {
      request?.abort();
      att.clear();
      if (store.primaryHandlers.teach === primary) delete store.primaryHandlers.teach;
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="teach" tabindex="-1" bind:this={rootEl} onkeydown={onKey}>
  {#if !started}
    <div class="start">
      <Clawd mood={store.liveMood} size={110} />
      <h2>What do you want to learn?</h2>
      <p class="muted lede">
        Name a concept, ask a question, or attach a photo of a problem. Clawd will teach it step by step, but it won't just hand
        you answers: expect questions back, and hints when you're stuck.
      </p>
      <div class="start-box">
        <div class="box ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
          {#if att.images.length}<div class="box-imgs"><Thumbs images={att.images} onremove={(i) => att.remove(i)} /></div>{/if}
          <textarea
            bind:value={topic}
            rows="2"
            aria-label="What do you want to learn?"
            placeholder="Ask a question or describe a topic…"
            onkeydown={(e) => enterToSend(e, () => void start())}
          ></textarea>
          <div class="ct-composer-actions">
            <AttachButton attachments={att} />
            <span class="ct-composer-hint">{SEND_HINT}</span>
            <SendButton label="Teach me" disabled={(!topic.trim() && !att.images.length) || held} onclick={() => start()} />
          </div>
        </div>
        <div class="ct-composer-footer">
          <div class="ct-composer-settings"><ModelPicker /></div>
        </div>
      </div>
      {#if suggestions.length}
        <div class="chips">
          <span class="faint small">From your library:</span>
          {#each suggestions as s}
            <button class="chip" onclick={() => start(s)}><Markdown md={s} inline /></button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <header class="top">
      <div class="title">
        <h3><Markdown md={topic} inline /></h3>
        <div class="progress" title="{progress}% through the lesson">
          <div class="bar"><div style="width: {progress}%"></div></div>
          {#if stepTitle}<span class="faint small">{done ? "Done" : stepTitle}</span>{/if}
        </div>
      </div>
      <div class="top-actions">
        <div class="ct-composer-settings wide-only"><ModelPicker /></div>
        {#if !done && history.length >= 4}
          <button class="btn ghost sm" disabled={held} onclick={() => control("wrap")}>Wrap up</button>
        {/if}
        <button class="btn ghost sm" disabled={waiting} onclick={newLesson}>New lesson</button>
      </div>
    </header>

    <div class="thread" bind:this={threadEl}>
      <div class="col">
        {#if sources.length}
          <div class="sources">
            <span class="faint small">Using your notes:</span>
            {#each sources as k}
              <button class="chip" onclick={() => store.openNote(k)}><Icon name="book" size={13} />{store.noteTitle(k)}</button>
            {/each}
          </div>
        {/if}
        {#each msgs as m (m.id)}
          {#if m.from === "me"}
            <div class="me">
              <div class="bubble mine">
                {#if m.images?.length}<Thumbs images={m.images.map((url) => ({ url }))} size={96} />{/if}
                {#if m.text}<Markdown md={m.text} />{/if}
              </div>
            </div>
          {:else if m.from === "clawd"}
            <div class="clawd-row">
              <div class="avatar">
                <Clawd mood={m.id === lastClawd && !waiting ? store.liveMood : m.mood} size={40} animate={m.id === lastClawd && !waiting} follow={false} />
              </div>
              <div class="bubble ct-card"><Markdown md={m.md} /></div>
            </div>
          {:else}
            <div class="clawd-row">
              <div class="avatar"><Clawd mood="confused" size={40} animate={false} /></div>
              <div class="bubble ct-card err">
                <p><b>I couldn't get an answer.</b></p>
                <p class="muted small">{m.text}</p>
                {#if m.retry}
                  {@const retry = m.retry}
                  <button class="btn sm" disabled={waiting} onclick={() => { msgs = msgs.filter((x) => x.id !== m.id); retry(); }}><Icon name="retry" size={15} />Try again</button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
        {#if waiting}
          <div class="clawd-row thinking-row" aria-live="polite">
            <div class="avatar"><Clawd mood="thinking" size={40} follow={false} /></div>
            <div class="bubble ct-card typing" aria-label="Clawd is thinking"><span></span><span></span><span></span></div>
            {#if slow}<p class="slow faint small">Still thinking… this can take a little while.</p>{/if}
          </div>
        {/if}
        {#if done && summary}
          <div class="ct-card summary">
            <p class="sec-title">Your study note</p>
            <Markdown md={summary} />
            <div class="summary-actions">
              {#if savedPath}
                <span class="saved"><Icon name="check" size={15} />Saved to {savedPath}</span>
              {:else}
                <button class="btn primary" disabled={saving} onclick={save}><Icon name="save" size={16} />Save as note</button>
              {/if}
              <button class="btn ghost" onclick={newLesson}>Learn something else</button>
            </div>
          </div>
        {/if}
      </div>
    </div>

    {#if !done}
      <footer class="composer">
        <div class="col">
          <div class="box ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
            {#if att.images.length}<div class="box-imgs"><Thumbs images={att.images} onremove={(i) => att.remove(i)} /></div>{/if}
            <textarea
              bind:this={inputEl}
              bind:value={draft}
              rows="2"
              disabled={waiting}
              aria-label="Your reply"
              placeholder={waiting ? "Clawd is thinking…" : "Your answer, your reasoning, or a question…"}
              onkeydown={(e) => enterToSend(e, submit)}
            ></textarea>
            <div class="ct-composer-actions">
              <AttachButton attachments={att} />
              <span class="ct-composer-hint">{SEND_HINT}</span>
              <SendButton label="Send" disabled={held || (!draft.trim() && !att.images.length)} onclick={submit} />
            </div>
          </div>
          <div class="ct-composer-footer">
            <div class="ct-composer-options">
              <button class="btn ghost sm self" disabled={held} onclick={() => control("hint")}><Icon name="bulb" size={15} />Hint</button>
              <button class="btn ghost sm self show" disabled={held} onclick={() => control("show")}><Icon name="eye" size={15} />Show me</button>
              <button class="btn ghost sm self got" disabled={held} onclick={() => control("next")}><Icon name="check" size={15} />I get it</button>
            </div>
            {#if busy}
              <button class="btn sm cancel" onclick={cancel} title="Stop this request (Esc)"><Icon name="x" size={14} />Cancel</button>
            {/if}
          </div>
          <!-- Narrow panes have no room in the header, so the model and effort switches sit under the entry box. -->
          <div class="ct-composer-footer model-row"><div class="ct-composer-settings"><ModelPicker /></div></div>
        </div>
      </footer>
    {/if}
  {/if}
</div>

<style>
  .teach:focus {
    outline: none;
  }
  .teach {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .start {
    margin: auto;
    width: 100%;
    max-width: 640px;
    padding: 32px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
  }
  .lede {
    max-width: 520px;
  }
  .start-box {
    width: 100%;
    text-align: left;
  }
  .start-box textarea {
    min-height: 72px;
  }
  .chips,
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    justify-content: center;
  }
  .sources {
    justify-content: flex-start;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 3px 11px;
    font-size: 0.85em;
    color: var(--text-2);
  }
  .chip:hover {
    border-color: var(--accent);
    color: var(--text);
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
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    min-width: 0;
    flex: 1;
  }
  .title h3 {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 6px;
  }
  .progress .bar {
    width: 160px;
    flex: none;
    height: 5px;
    border-radius: 99px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .progress .bar div {
    height: 100%;
    background: var(--accent);
    transition: width 0.5s;
  }
  .top-actions {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 0 12px;
  }
  .thread .col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .clawd-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .avatar {
    width: 44px;
    flex: none;
    display: flex;
    justify-content: center;
    padding-top: 2px;
  }
  .bubble {
    padding: 14px 18px;
    border-radius: 4px var(--r-lg) var(--r-lg) var(--r-lg);
    min-width: 0;
    flex: 1;
  }
  .bubble.err {
    border-color: var(--bad);
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .me {
    display: flex;
    justify-content: flex-end;
  }
  .mine {
    flex: none;
    max-width: min(560px, 85%);
    background: var(--accent-soft);
    border-radius: var(--r-lg) 4px var(--r-lg) var(--r-lg);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .thinking-row {
    flex-wrap: wrap;
  }
  .slow {
    flex-basis: 100%;
    padding-left: 54px;
  }
  .cancel {
    margin-left: auto;
  }
  .typing {
    flex: none;
    display: flex;
    gap: 5px;
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
  .summary {
    padding: 18px 20px;
    border-color: var(--accent);
  }
  .summary-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .saved {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--good);
    font-size: 0.9em;
  }
  .composer {
    flex: none;
    border-top: 1px solid var(--border);
    padding: 10px 0 16px;
  }
  .box-imgs {
    padding: 10px 10px 0;
  }
  .self {
    opacity: 0.55;
    transition: opacity 0.12s;
  }
  .self:hover:not(:disabled),
  .self:focus-visible {
    opacity: 1;
  }
  .show {
    color: var(--warn);
  }
  .got {
    color: var(--good);
  }
  @keyframes dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
    }
    30% {
      opacity: 1;
    }
  }
  .composer .model-row {
    display: none;
  }
  @container (max-width: 560px) {
    .wide-only {
      display: none;
    }
    .composer .model-row {
      display: flex;
    }
    .col {
      padding: 0 12px;
    }
    .progress .bar {
      width: 90px;
    }
  }
</style>
