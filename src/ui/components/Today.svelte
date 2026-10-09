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
  const caughtUp = $derived(ready && !due.length);
  const activity = $derived(store.snap?.activity ?? []);
  const peak = $derived(Math.max(1, ...activity));
  const streak = $derived(store.snap?.streak ?? 0);
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function dayName(i: number) {
    const d = new Date();
    d.setDate(d.getDate() - (activity.length - 1 - i));
    return i === activity.length - 1 ? "Today" : DAY[d.getDay()];
  }
  const summary = $derived(
    [
      explainCount && `Explain ${explainCount} concept${explainCount > 1 ? "s" : ""} in your own words`,
      quizCount && `${explainCount ? "then a" : "A"} ${quizCount}-question quiz`,
    ]
      .filter(Boolean)
      .join(", ") + ` · about ${minutes} min`,
  );

  // Notes Clawd hasn't read yet: nothing is sent to Claude until you tick them here.
  const unread = $derived(store.unread);
  let picked = $state<string[]>([]);
  let filterText = $state("");
  const shownUnread = $derived(unread.filter((n) => n.title.toLowerCase().includes(filterText.trim().toLowerCase())).slice(0, 200));
  const pickedKeys = $derived(picked.filter((k) => unread.some((n) => n.key === k)));
  function togglePick(key: string) {
    picked = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
  }
  function readPicked() {
    const keys = pickedKeys;
    picked = [];
    void store.readSelected(keys);
  }

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
    } else if (e.key.toLowerCase() === "e") {
      e.preventDefault();
      e.stopPropagation();
      store.pickConcept();
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
    <section class="ct-card confirm">
      <div>
        <h3>Re-read {store.confirmCount} edited notes?</h3>
        <p class="muted small">
          That's {store.confirmCount} Claude requests, which uses some of your subscription. You can also skip this and
          re-read notes one at a time from the Library tab.
        </p>
      </div>
      <div class="confirm-actions">
        <button class="btn ghost" onclick={() => store.confirmBulk(false)}>Not now</button>
        <button class="btn primary" onclick={() => store.confirmBulk(true)}>Re-read them</button>
      </div>
    </section>
  {/if}

  {#if store.indexing && !ready}
    <section class="ct-card reading">
      <Clawd mood="thinking" size={56} follow={false} />
      <div>
        <h3>Clawd is reading your notes</h3>
        <p class="muted small">{store.indexing.done + 1} of {store.indexing.total}: {store.indexing.current}</p>
        <div class="bar"><div style="width: {(store.indexing.done / store.indexing.total) * 100}%"></div></div>
      </div>
    </section>
  {/if}

  <!-- Start studying and the quick actions, side by side. -->
  <section class="quick">
    <div class="ct-card primary-card">
      <span class="ti" style="color: var(--good)"><Icon name="sun" /></span>
      <b>{due.length ? "Today's session" : ready ? "All caught up" : "Getting ready…"}{#if ready && !(caughtUp && !plan.length)}{" "}<kbd>Enter</kbd>{/if}</b>
      <small>
        {#if !ready}
          Pick at least one note for Clawd to read first.
        {:else if caughtUp && plan.length}
          Nothing is due. Get ahead: {summary}
        {:else if caughtUp}
          Nothing is due. Try Teach to learn something new.
        {:else if plan.length}
          {summary}
        {/if}
      </small>
      {#if caughtUp && !plan.length}
        <button class="btn primary" onclick={() => (store.view = { name: "teach" })}><Icon name="sparkles" size={15} />Learn something new</button>
      {:else}
        <button class="btn primary" disabled={!ready} onclick={() => store.startStudy()}>
          <Icon name="play" size={15} />{caughtUp ? "Review ahead" : "Start studying"}
        </button>
      {/if}
    </div>
    <button class="tile ct-card" disabled={!ready} onclick={() => store.pickConcept()}>
      <span class="ti" style="color: var(--accent)"><Icon name="brain" /></span>
      <b>Explain a concept <kbd>E</kbd></b>
      <small>Search all {store.concepts.length} concepts</small>
    </button>
    <button class="tile ct-card" disabled={!ready} onclick={() => store.quickQuiz()}>
      <span class="ti" style="color: var(--violet)"><Icon name="zap" /></span>
      <b>Quick quiz <kbd>Q</kbd></b>
      <small>5 questions on what's due</small>
    </button>
    <button class="tile ct-card" disabled={!store.mistakes.length} onclick={() => store.mistakesQuiz()}>
      <span class="ti" style="color: var(--bad)"><Icon name="target" /></span>
      <b>Fix my mistakes</b>
      <small>{store.mistakes.length ? `${store.mistakes.length} misconception${store.mistakes.length > 1 ? "s" : ""} to clear` : "Nothing to fix yet"}</small>
    </button>
  </section>

  <section class="stats">
    <div><b>{due.length}</b><span>due</span></div>
    <div><b style="color: var(--good)">{mastered}</b><span>solid</span></div>
    <div><b>{store.concepts.length}</b><span>concepts</span></div>
    <div title="Days in a row with at least one review">
      <b style:color={streak ? "var(--accent)" : undefined}>{streak}</b><span>day streak</span>
    </div>
    {#if activity.length}
      <div class="week" role="img" aria-label="Reviews over the last 7 days: {activity.map((n, i) => `${dayName(i)} ${n}`).join(', ')}">
        {#each activity as n, i}
          <span class="day" class:today={i === activity.length - 1} title="{dayName(i)}: {n} review{n === 1 ? '' : 's'}">
            <span class="fill" style:height="{n ? Math.max(12, (n / peak) * 100) : 0}%"></span>
          </span>
        {/each}
        <span class="week-label">7 days</span>
      </div>
    {/if}
  </section>

  {#if unread.length && !store.indexing}
    <section class="ct-card pick">
      <div>
        <h3>Which notes should Clawd read?</h3>
        <p class="muted small">
          {unread.length} note{unread.length > 1 ? "s" : ""} in your library {unread.length > 1 ? "haven't" : "hasn't"} been
          read yet. Clawd only reads the ones you tick (one Claude request each).
        </p>
      </div>
      {#if unread.length > 8}
        <div class="pick-search">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Filter notes" bind:value={filterText} />
        </div>
      {/if}
      <div class="pick-list">
        {#each shownUnread as n (n.key)}
          <label class="pick-row" class:sel={picked.includes(n.key)}>
            <input type="checkbox" checked={picked.includes(n.key)} onchange={() => togglePick(n.key)} />
            <Icon name="file" size={16} />
            <span class="pick-title" title={n.rel}>{n.title}</span>
          </label>
        {/each}
      </div>
      <div class="confirm-actions">
        <button class="btn primary" disabled={!pickedKeys.length} onclick={readPicked}>
          Read {pickedKeys.length || ""} selected
        </button>
      </div>
    </section>
  {/if}

  {#if due.length}
    <section>
      <h3 class="section-title">Up next</h3>
      <div class="ct-card list">
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
  .pick {
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .pick h3 {
    margin-bottom: 4px;
  }
  .pick .confirm-actions {
    justify-content: flex-end;
  }
  .pick-search {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-3);
  }
  .pick-search input {
    flex: 1;
  }
  .pick-list {
    max-height: 260px;
    overflow: auto;
  }
  .pick-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
    color: var(--text-2);
  }
  .pick-row:hover {
    background: var(--surface-2);
  }
  .pick-row.sel {
    background: var(--accent-soft);
    color: var(--text);
  }
  .pick-row input {
    margin: 0;
  }
  .pick-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  /* Laid out like the quick-action tiles beside it, with the button along the bottom. */
  .primary-card {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    border-color: var(--accent);
    background: linear-gradient(135deg, var(--accent-soft), transparent 70%), var(--surface);
  }
  .primary-card b {
    font-weight: 600;
  }
  .primary-card small {
    color: var(--text-2);
    font-size: 0.84rem;
  }
  .primary-card .btn {
    margin-top: auto;
    width: 100%;
    padding: 0 10px;
  }
  .primary-card small + .btn {
    margin-top: 12px;
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
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
  .week {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 24px;
    margin-left: auto;
  }
  .day {
    width: 7px;
    height: 100%;
    border-radius: 2px;
    background: var(--surface-2);
    display: flex;
    align-items: flex-end;
    overflow: hidden;
  }
  .fill {
    width: 100%;
    background: var(--text-3);
    border-radius: 2px;
  }
  .day.today .fill {
    background: var(--accent);
  }
  .stats .week-label {
    font-size: 0.75rem;
    color: var(--text-3);
    margin-left: 4px;
    align-self: center;
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
  @container (max-width: 900px) {
    .quick {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @container (max-width: 420px) {
    .page {
      padding: 20px 14px 32px;
    }
    .quick {
      grid-template-columns: minmax(0, 1fr);
    }
    .stats {
      gap: 8px 18px;
    }
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
