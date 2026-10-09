<script lang="ts">
  import type { Question } from "../lib/api";
  import Markdown from "./Markdown.svelte";
  import Icon from "./Icon.svelte";

  let {
    q,
    n,
    total,
    choice = null,
    answered = null,
    interactive,
    onchoose,
  }: {
    q: Question;
    n: number;
    total: number;
    choice?: number | null;
    answered?: number | null;
    interactive: boolean;
    onchoose: (i: number) => void;
  } = $props();

  const KIND = { mcq: "Multiple choice", short: "Short answer", explain_why: "Explain why", spot_error: "Spot the error" };
  const mcq = $derived(q.kind === "mcq" && q.options.length > 0);
  const revealed = $derived(answered !== null);

  /** Arrow keys move the selection, like native radio buttons. */
  function onKey(e: KeyboardEvent) {
    if (!interactive) return;
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const n = q.options.length;
    const next = choice === null ? (dir > 0 ? 0 : n - 1) : (choice + dir + n) % n;
    onchoose(next);
    const group = e.currentTarget as HTMLElement;
    queueMicrotask(() => group.querySelectorAll<HTMLElement>("button")[next]?.focus());
  }
</script>

<div class="q">
  <p class="meta">
    <span>Question {n} of {total}</span><span class="dot">·</span><span>{KIND[q.kind] ?? "Question"}</span><span
      class="dot">·</span
    ><span class="concept"><Markdown md={q.concept} inline /></span>
  </p>
  <Markdown md={q.question} />
  {#if mcq}
    <div class="opts" role="radiogroup" aria-label="Answer options" tabindex="-1" onkeydown={onKey}>
      {#each q.options as o, i}
        {@const correct = revealed && i === q.correct_option}
        {@const wrong = revealed && answered === i && i !== q.correct_option}
        <button
          role="radio"
          aria-checked={revealed ? answered === i : choice === i}
          tabindex={interactive && (choice === i || (choice === null && i === 0)) ? 0 : -1}
          class:sel={!revealed && choice === i}
          class:correct
          class:wrong
          disabled={!interactive}
          onclick={() => onchoose(i)}
        >
          <span class="key">{correct ? "" : "ABCD"[i] ?? i + 1}{#if correct}<Icon name="check" size={14} stroke={3} />{/if}</span>
          <span class="opt-text"><Markdown md={o} inline /></span>
          {#if correct}<span class="ct-sr-only">(correct answer)</span>{:else if wrong}<span class="ct-sr-only">(your answer, incorrect)</span>{/if}
        </button>
      {/each}
    </div>
    {#if interactive}<p class="faint small">Press 1–{q.options.length} to choose, G / U / C for how sure you are</p>{/if}
  {/if}
</div>

<style>
  .q {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .meta {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-3);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .concept {
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0;
  }
  .opts {
    display: grid;
    gap: 8px;
  }
  .opts button {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    text-align: left;
    padding: 11px 14px;
    border-radius: var(--r-md);
    border: 1.5px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    font-size: 0.97rem;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  .opts button:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }
  .opts button:disabled {
    cursor: default;
  }
  .opts button.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .opts button.correct {
    border-color: var(--good);
    background: var(--good-soft);
  }
  .opts button.wrong {
    border-color: var(--bad);
    background: var(--bad-soft);
  }
  .key {
    width: 24px;
    height: 24px;
    flex: none;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-size: 0.78rem;
    font-weight: 700;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .sel .key {
    background: var(--accent);
    color: var(--accent-text);
  }
  .correct .key {
    background: var(--good);
    color: var(--surface);
  }
  .wrong .key {
    background: var(--bad);
    color: var(--surface);
  }
</style>
