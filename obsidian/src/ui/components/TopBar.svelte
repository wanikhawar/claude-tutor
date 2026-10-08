<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";

  const v = $derived(store.view.name);
</script>

<header class="bar">
  <nav>
    <button class:active={v === "today"} onclick={() => (store.view = { name: "today" })}>Today</button>
    {#if store.plan}
      <button class:active={v === "session"} onclick={() => (store.view = { name: "session" })}><span class="live"></span>Session</button>
    {/if}
    <button class:active={v === "teach"} onclick={() => (store.view = { name: "teach" })}>Teach</button>
    <button class:active={v === "library"} onclick={() => (store.view = { name: "library" })}>Library</button>
    <button class:active={v === "mistakes"} onclick={() => (store.view = { name: "mistakes" })}>
      Mistakes{#if store.mistakes.length}<span class="count">{store.mistakes.length}</span>{/if}
    </button>
  </nav>

  <div class="right">
    {#if store.indexing}
      <div class="chip" title="Clawd is reading: {store.indexing.current}">
        <Ring value={store.indexing.done / store.indexing.total} size={15} width={2.5} />
        <span class="label">Reading {store.indexing.done + 1}/{store.indexing.total}</span>
      </div>
    {:else if store.indexError}
      <button class="chip bad" title={store.indexError} onclick={() => store.retryIndexing()}>
        <Icon name="alert" size={14} /><span class="label">Couldn't read a note · Retry</span>
      </button>
    {/if}
    <button class="btn ghost icon" aria-label="Settings" title="Claude Tutor settings" onclick={() => api.openSettings()}>
      <Icon name="settings" />
    </button>
  </div>
</header>

<style>
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  nav {
    display: flex;
    gap: 2px;
    background: var(--surface-2);
    padding: 3px;
    border-radius: 10px;
    min-width: 0;
    overflow-x: auto;
  }
  nav button {
    padding: 4px 12px;
    border-radius: 7px;
    font-weight: 550;
    font-size: 0.88em;
    color: var(--text-2);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  nav button:hover {
    color: var(--text);
  }
  nav button.active {
    background: var(--bg);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .count {
    background: var(--bad-soft);
    color: var(--bad);
    font-size: 0.78em;
    font-weight: 700;
    padding: 0 6px;
    border-radius: 99px;
  }
  .live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.8em;
    color: var(--text-2);
    padding: 3px 10px;
    border-radius: 99px;
    background: var(--surface-2);
    white-space: nowrap;
  }
  .chip.bad {
    color: var(--bad);
    background: var(--bad-soft);
  }
  @container (max-width: 420px) {
    .label {
      display: none;
    }
  }
</style>
