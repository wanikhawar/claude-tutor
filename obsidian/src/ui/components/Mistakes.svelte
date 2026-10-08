<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { api, errText } from "../lib/api";
  import Clawd from "./Clawd.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";

  async function resolve(id: number) {
    try {
      store.snap = await api.resolveMistake(id);
      store.say("proud", "One less misconception. Love to see it.");
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
      {#each store.mistakes as m (m.id)}
        <div class="card item">
          <span class="mark"><Icon name="alert" size={18} /></span>
          <div class="text">
            <p><Markdown md={m.text} inline /></p>
            {#if m.concept_name}<span class="chip"><Markdown md={m.concept_name} inline /></span>{/if}
          </div>
          <div class="acts">
            {#if m.concept_id !== null}
              <button class="btn sm" onclick={() => store.startExplain(m.concept_id!)}>Practice</button>
            {/if}
            <button class="btn sm ghost" title="Mark as resolved" onclick={() => resolve(m.id)}><Icon name="check" size={15} />Resolved</button>
          </div>
        </div>
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
  .item {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 14px 16px;
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
  .chip {
    display: inline-block;
    margin-top: 6px;
    font-size: 0.78rem;
    color: var(--text-2);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 99px;
  }
  .acts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
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
