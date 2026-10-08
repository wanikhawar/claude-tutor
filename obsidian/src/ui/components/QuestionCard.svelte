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
</script>

<div class="q">
  <p class="meta">
    <span>Question {n} of {total}</span><span class="dot">·</span><span>{KIND[q.kind] ?? "Question"}</span><span
      class="dot">·</span
    ><span class="concept"><Markdown md={q.concept} inline /></span>
  </p>
  <Markdown md={q.question} />
  {#if mcq}
    <div class="opts">
      {#each q.options as o, i}
        {@const correct = revealed && i === q.correct_option}
        {@const wrong = revealed && answered === i && i !== q.correct_option}
        <button
          class:sel={!revealed && choice === i}
          class:correct
          class:wrong
          disabled={!interactive}
          onclick={() => onchoose(i)}
        >
          <span class="key">{correct ? "" : "ABCD"[i] ?? i + 1}{#if correct}<Icon name="check" size={14} stroke={3} />{/if}</span>
          <span class="opt-text"><Markdown md={o} inline /></span>
        </button>
      {/each}
    </div>
    {#if interactive}<p class="faint small">Press 1–{q.options.length} to choose</p>{/if}
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
