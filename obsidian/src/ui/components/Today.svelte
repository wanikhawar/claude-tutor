<script lang="ts">
  import { store, isNew } from "../lib/store.svelte";
  import { greeting, masteryColor, relativeDue } from "../lib/util";
  import Clawd from "./Clawd.svelte";
  import Speech from "./Speech.svelte";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";
  import Markdown from "./Markdown.svelte";

  const due = $derived(store.dueConcepts());
  const plan = $derived(store.studyPlan());
  const explainCount = $derived(plan.filter((s) => s.kind === "explain").length);
  const quizCount = $derived(plan.reduce((n, s) => n + (s.kind === "quiz" ? s.count : 0), 0));
  const minutes = $derived(explainCount * 4 + quizCount);
  const mastered = $derived(store.concepts.filter((c) => c.mastery >= 0.8).length);
  const ready = $derived(store.concepts.length > 0);
  const summary = $derived(
    [
      explainCount && `Explain ${explainCount} concept${explainCount > 1 ? "s" : ""} in your own words`,
      quizCount && `${explainCount ? "then a" : "A"} ${quizCount}-question quiz`,
    ]
      .filter(Boolean)
      .join(", ") + ` · about ${minutes} min`,
  );

  let root = $state<HTMLDivElement>();
  // Shortcuts only work while the tutor view has focus, so they never fight Obsidian's hotkeys.
  $effect(() => {
    root?.focus({ preventScroll: true });
  });

  function onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing || !ready || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" && (e.target as Element)?.tagName !== "BUTTON") {
      e.preventDefault();
      e.stopPropagation();
      store.startStudy();
    } else if (e.key.toLowerCase() === "q") {
      e.preventDefault();
      e.stopPropagation();
      store.quickQuiz();
    }
  }

  const pokes = [
    "Hey! These glasses aren't cheap.",
    "*pushes glasses up* Where were we?",
    "If you can't explain it simply, you don't understand it yet. Feynman said so.",
    "I read all your notes. No judgement about the typos.",
    "Psst: confident-but-wrong answers are gold. They show us where to dig.",
    "Poke me again and I'm giving you a pop quiz.",
  ];
  let pokeN = 0;
  function poke() {
    store.say(pokeN % pokes.length === pokes.length - 1 ? "confused" : "proud", pokes[pokeN++ % pokes.length]);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="page" tabindex="-1" bind:this={root} onkeydown={onKey}>
  <section class="hero">
    <Clawd mood={store.liveMood} size={132} onpoke={poke} />
    <div class="hero-text">
      <p class="eyebrow">{greeting()}</p>
      {#key store.lineId}<Speech text={store.line} />{/key}
    </div>
  </section>

  {#if store.confirmCount}
    <section class="card confirm">
      <div>
        <h3>Read {store.confirmCount} notes?</h3>
        <p class="muted small">
          That's {store.confirmCount} Claude requests, which uses some of your subscription. You can also skip this and
          right-click a note → “Quiz me on this” to read notes one at a time.
        </p>
      </div>
      <div class="confirm-actions">
        <button class="btn ghost" onclick={() => store.confirmBulk(false)}>Not now</button>
        <button class="btn primary" onclick={() => store.confirmBulk(true)}>Read them all</button>
      </div>
    </section>
  {/if}

  {#if store.indexing && !ready}
    <section class="card reading">
      <Clawd mood="thinking" size={56} follow={false} />
      <div>
        <h3>Clawd is reading your notes</h3>
        <p class="muted small">{store.indexing.done + 1} of {store.indexing.total}: {store.indexing.current}</p>
        <div class="bar"><div style="width: {(store.indexing.done / store.indexing.total) * 100}%"></div></div>
      </div>
    </section>
  {/if}

  <section class="card primary-card">
    <div>
      <h2>{due.length ? "Ready for today's session" : ready ? "You're all caught up" : "Getting ready…"}</h2>
      <p class="muted">
        {#if !ready}
          Clawd needs to read your notes before the first session.
        {:else if plan.length}
          {summary}
        {/if}
      </p>
    </div>
    <button class="btn primary lg" disabled={!ready} onclick={() => store.startStudy()}>
      <Icon name="play" size={16} />Start studying<kbd>Enter</kbd>
    </button>
  </section>

  <section class="quick">
    <button class="tile card" disabled={!ready} onclick={() => (store.view = { name: "library" })}>
      <span class="ti" style="color: var(--accent)"><Icon name="brain" /></span>
      <b>Explain a concept</b>
      <small>Pick any concept from your library</small>
    </button>
    <button class="tile card" disabled={!ready} onclick={() => store.quickQuiz()}>
      <span class="ti" style="color: var(--violet)"><Icon name="zap" /></span>
      <b>Quick quiz <kbd>Q</kbd></b>
      <small>5 questions on what's due</small>
    </button>
    <button class="tile card" disabled={!store.mistakes.length} onclick={() => store.mistakesQuiz()}>
      <span class="ti" style="color: var(--bad)"><Icon name="target" /></span>
      <b>Fix my mistakes</b>
      <small>{store.mistakes.length ? `${store.mistakes.length} misconception${store.mistakes.length > 1 ? "s" : ""} to clear` : "Nothing to fix yet"}</small>
    </button>
  </section>

  <section class="stats">
    <div><b>{due.length}</b><span>due</span></div>
    <div><b style="color: var(--good)">{mastered}</b><span>solid</span></div>
    <div><b>{store.concepts.length}</b><span>concepts</span></div>
    <div><b>{store.snap?.reviews_today ?? 0}</b><span>reviews today</span></div>
  </section>

  {#if due.length}
    <section>
      <h3 class="section-title">Up next</h3>
      <div class="card list">
        {#each due.slice(0, 8) as c (c.id)}
          <button class="row" onclick={() => store.startExplain(c.id)}>
            <Ring value={c.mastery} size={18} width={3} color={masteryColor(c)} empty={isNew(c)} />
            <span class="name"><Markdown md={c.name} inline /></span>
            <span class="note faint">{store.noteTitle(c.note_path)}</span>
            <span class="when" class:new={isNew(c)}>{isNew(c) ? "new" : relativeDue(c)}</span>
            <Icon name="right" size={16} />
          </button>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .page {
    width: 100%;
    max-width: 820px;
    margin: 0 auto;
    padding: 32px 24px 48px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .hero-text {
    flex: 1;
    min-width: 0;
  }
  .eyebrow {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin: 0 0 8px 4px;
  }
  .page:focus {
    outline: none;
  }
  .confirm {
    padding: 16px 20px;
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    border-color: var(--accent);
  }
  .confirm > div:first-child {
    flex: 1;
    min-width: 220px;
  }
  .confirm-actions {
    display: flex;
    gap: 8px;
  }
  .reading {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
  }
  .reading > div {
    flex: 1;
  }
  .bar {
    height: 6px;
    border-radius: 99px;
    background: var(--surface-3);
    margin-top: 10px;
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    border-radius: 99px;
    transition: width 0.4s;
  }
  .primary-card {
    padding: 22px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
    background: linear-gradient(135deg, var(--accent-soft), transparent 70%), var(--surface);
  }
  .primary-card h2 {
    margin-bottom: 4px;
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px;
  }
  .tile {
    text-align: left;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      transform 0.12s;
  }
  .tile:hover:not(:disabled) {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .tile:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ti {
    margin-bottom: 8px;
  }
  .tile b {
    font-weight: 600;
  }
  .tile small {
    color: var(--text-2);
    font-size: 0.84rem;
  }
  .stats {
    display: flex;
    gap: 28px;
    padding: 0 4px;
    flex-wrap: wrap;
  }
  .stats div {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .stats b {
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .stats span {
    color: var(--text-2);
    font-size: 0.88rem;
  }
  .section-title {
    margin: 4px 4px 10px;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }
  .list {
    overflow: hidden;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    color: var(--text-3);
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  .row:hover {
    background: var(--surface-2);
  }
  .name {
    color: var(--text);
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note {
    flex: 1;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    font-size: 0.8rem;
    color: var(--text-2);
  }
  .when.new {
    color: var(--accent);
    font-weight: 600;
  }
  @container (max-width: 560px) {
    .hero {
      flex-direction: column;
      text-align: center;
    }
    .note {
      display: none;
    }
  }
</style>
