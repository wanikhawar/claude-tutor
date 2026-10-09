<script lang="ts">
  import type { Grade, Question } from "../lib/api";
  import Markdown from "./Markdown.svelte";
  import Icon from "./Icon.svelte";

  let { g, q, latest, onexplain }: { g: Grade; q: Question; latest: boolean; onexplain?: () => void } = $props();

  const state = $derived(g.correct ? "good" : g.score >= 40 ? "part" : "bad");
  const title = $derived(g.correct ? "Correct" : g.score >= 40 ? "Partly right" : "Not quite");
</script>

<div class="grade">
  <div class="verdict {state}">
    <span class="badge"><Icon name={g.correct ? "check" : state === "part" ? "help" : "x"} size={16} stroke={3} /></span>
    <h3>{title}</h3>
  </div>
  {#if g.feedback}<Markdown md={g.feedback} />{/if}

  {#if !g.correct}
    {#if g.misconception}
      <div class="ct-callout warn">
        <Icon name="target" />
        <div><b>What went wrong</b><p><Markdown md={g.misconception} inline /></p></div>
      </div>
    {/if}
    {#if g.prerequisite_gap}
      <div class="ct-callout info"><Icon name="layers" /><p>Root cause might be: <b><Markdown md={g.prerequisite_gap} inline /></b></p></div>
    {/if}
    {#if g.lesson}
      <details class="fold" open={latest}><summary>Mini-lesson</summary><Markdown md={g.lesson} /></details>
    {/if}
    {#if g.analogy}
      <div class="ct-callout bulb"><Icon name="bulb" /><p><Markdown md={g.analogy} inline /></p></div>
    {/if}
    <details class="fold"><summary>Answer key</summary><div class="muted"><Markdown md={q.answer} /></div></details>
    {#if g.check_question}
      <div class="check">
        <p class="sec-title">Quick check</p>
        <Markdown md={g.check_question} />
      </div>
    {/if}
    {#if onexplain && latest}
      <button class="btn sm ghost self-start" onclick={onexplain}><Icon name="brain" size={15} />Explain this concept next</button>
    {/if}
  {/if}
</div>

<style>
  .grade {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .badge {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--surface);
  }
  .good .badge {
    background: var(--good);
  }
  .part .badge {
    background: var(--warn);
  }
  .bad .badge {
    background: var(--bad);
  }
  .check {
    border-left: 3px solid var(--accent);
    padding: 4px 0 4px 14px;
  }
  .self-start {
    align-self: flex-start;
  }
</style>
