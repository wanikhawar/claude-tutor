<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { api, errText, type Mistake } from "../lib/api";
  import { timeAgo } from "../lib/util";
  import Clawd from "./Clawd.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";

  /** Mistakes grouped by concept, in the order they were logged (newest first). */
  const groups = $derived.by(() => {
    const out: { id: number | null; name: string | null; items: Mistake[] }[] = [];
    for (const m of store.mistakes) {
      let g = out.find((x) => x.id === m.concept_id);
      if (!g) out.push((g = { id: m.concept_id, name: m.concept_name, items: [] }));
      g.items.push(m);
    }
    return out;
  });

  async function resolve(id: number) {
    try {
      store.snap = await api.resolveMistake(id);
      store.say("proud", "One less misconception. Love to see it.");
      store.notify("Marked as resolved.", { label: "Undo", run: () => void reopen(id) });
    } catch (e) {
      store.error = errText(e);
    }
  }

  async function reopen(id: number) {
    try {
      store.snap = await api.reopenMistake(id);
    } catch (e) {
      store.error = errText(e);
    }
  }
</script>

<div class="page">
  <header>
    <div>
      <h1>Mistakes</h1>
      <p class="muted">
        Every wrong belief Clawd spots lands here. Quizzes keep targeting them until a check question proves they're fixed.
      </p>
    </div>
    {#if store.mistakes.length}
      <button class="btn primary" onclick={() => store.mistakesQuiz()}><Icon name="target" size={16} />Practice all</button>
    {/if}
  </header>

  {#if !store.mistakes.length}
    <div class="empty">
      <Clawd mood="proud" size={110} />
      <h2>No misconceptions logged</h2>
      <p class="muted">Either you're brilliant or we haven't quizzed yet.</p>
    </div>
  {:else}
    <div class="list">
      {#each groups as g (g.id)}
        <section class="ct-card group" aria-label={g.name ?? "Other"}>
          <header class="g-head">
            <h3><Markdown md={g.name ?? "Other"} inline /></h3>
            <span class="faint small">{g.items.length} open</span>
            {#if g.id !== null}
              <button class="btn sm" onclick={() => store.startExplain(g.id!)}>Practice</button>
            {/if}
          </header>
          {#each g.items as m (m.id)}
            <div class="item">
              <span class="mark"><Icon name="alert" size={18} /></span>
              <div class="text">
                <p><Markdown md={m.text} inline /></p>
                <p class="meta faint small">
                  {#if m.ts}<span title={new Date(m.ts).toLocaleString()}>Logged {timeAgo(m.ts)}</span>{/if}
                  {#if m.source}<span class="src">· while answering “<Markdown md={m.source} inline />”</span>{/if}
                </p>
              </div>
              <button class="btn sm ghost" title="Mark as resolved" onclick={() => resolve(m.id)}><Icon name="check" size={15} />Resolved</button>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    width: 100%;
    max-width: 820px;
    margin: 0 auto;
    padding: 32px 24px 48px;
  }
  header {
    display: flex;
    gap: 20px;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  header p {
    max-width: 520px;
    margin-top: 6px;
  }
  .list {
    display: grid;
    gap: 10px;
  }
  .group {
    overflow: hidden;
  }
  .g-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    margin: 0;
    border-bottom: 1px solid var(--border);
    flex-wrap: nowrap;
  }
  .g-head h3 {
    flex: 1;
    min-width: 0;
  }
  .item {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 12px 16px;
  }
  .item + .item {
    border-top: 1px solid var(--border);
  }
  .meta {
    margin-top: 4px;
  }
  .mark {
    color: var(--warn);
    padding-top: 2px;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .text p {
    font-weight: 500;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 48px 0;
    text-align: center;
  }
</style>
