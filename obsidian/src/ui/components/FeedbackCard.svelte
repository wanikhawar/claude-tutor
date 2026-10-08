<script lang="ts">
  import type { FeynmanEval } from "../lib/api";
  import { store } from "../lib/store.svelte";
  import { scoreColor } from "../lib/util";
  import Markdown from "./Markdown.svelte";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";

  let {
    ev,
    stuck = false,
    latest,
    interactive,
    conceptId,
    onprereq,
  }: { ev: FeynmanEval; stuck?: boolean; latest: boolean; interactive: boolean; conceptId: number; onprereq: (id: number) => void } =
    $props();

  const verdict = $derived(
    ev.passed
      ? "You've got it!"
      : stuck
        ? "Let's learn it together"
        : ev.score >= 60
          ? "Almost there"
          : ev.score >= 30
            ? "Good start"
            : "Let's build this up",
  );
  const prereq = $derived(ev.prerequisite_gap ? store.conceptByName(ev.prerequisite_gap) : undefined);
  const LABEL = { wrong: "Wrong", missing: "Missing", jargon: "Jargon", vague: "Vague" } as const;
</script>

<div class="fb">
  <div class="head">
    {#if !stuck}
      <Ring value={ev.score / 100} size={52} width={5} color={scoreColor(ev.score)} label={String(Math.round(ev.score))} />
    {/if}
    <div>
      <h3>{verdict}</h3>
      {#if ev.mascot_line}<p class="muted"><Markdown md={ev.mascot_line} inline /></p>{/if}
    </div>
  </div>

  {#if ev.got_right.length}
    <div>
      <p class="sec-title">What you nailed</p>
      <ul class="good">
        {#each ev.got_right as r}<li><Icon name="check" size={16} /><span><Markdown md={r} inline /></span></li>{/each}
      </ul>
    </div>
  {/if}

  {#if ev.gaps.length}
    <div>
      <p class="sec-title">Gaps to fix</p>
      <div class="gaps">
        {#each ev.gaps as g}
          <div class="gap">
            <span class="pill {g.kind}">{LABEL[g.kind] ?? g.kind}</span>
            <div>
              <p><Markdown md={g.issue} inline /></p>
              {#if g.fix}<p class="fix"><b>Better:</b> <Markdown md={g.fix} inline /></p>{/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if ev.reteach.trim()}
    <details class="fold" open={latest}>
      <summary>{ev.passed ? "One level deeper" : stuck ? "The lesson" : "Let me re-explain"}</summary>
      <Markdown md={ev.reteach} />
    </details>
  {/if}

  {#if ev.analogy.trim()}
    <div class="ct-callout bulb"><Icon name="bulb" /><p><Markdown md={ev.analogy} inline /></p></div>
  {/if}

  {#if ev.prerequisite_gap.trim()}
    <div class="ct-callout info">
      <Icon name="layers" />
      <div class="grow">
        <p>Missing foundation: <b><Markdown md={ev.prerequisite_gap} inline /></b></p>
        {#if prereq && prereq.id !== conceptId && latest}
          <button class="btn sm" disabled={!interactive} onclick={() => onprereq(prereq.id)}>Learn “<Markdown md={prereq.name} inline />” first</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if ev.note_issues.length}
    <details class="fold">
      <summary><Icon name="pencil" size={15} />Your notes could be clearer</summary>
      <ul class="plain">{#each ev.note_issues as n}<li><Markdown md={n} inline /></li>{/each}</ul>
    </details>
  {/if}

  {#if ev.next_prompt.trim()}
    <p class="next"><b>{ev.passed ? "Stretch question" : "Your turn"}:</b> <Markdown md={ev.next_prompt} inline /></p>
  {/if}
</div>

<style>
  .fb {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .head {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .head h3 {
    font-size: 1.1rem;
  }
  .head p {
    font-size: 0.92rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .good li {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .good :global(.icon) {
    color: var(--good);
    margin-top: 3px;
  }
  .gaps {
    display: grid;
    gap: 10px;
  }
  .gap {
    display: grid;
    grid-template-columns: 74px 1fr;
    gap: 10px;
    align-items: start;
  }
  .gap .pill {
    justify-self: start;
    margin-top: 2px;
  }
  .fix {
    color: var(--text-2);
    font-size: 0.92rem;
    margin-top: 2px;
  }
  .fix b {
    font-weight: 600;
    color: var(--good);
  }
  .grow {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  .plain {
    list-style: disc;
    padding-left: 1.2em;
    color: var(--text-2);
  }
  .next {
    padding: 12px 14px;
    background: var(--accent-soft);
    border-radius: var(--r-md);
  }
  .next b {
    color: var(--accent);
  }
</style>
