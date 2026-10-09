<!-- The app's navigation: a rail down the left, with labels when there's room and icons only when narrow. -->
<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { View } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";

  const v = $derived(store.view.name);
  const items = $derived(
    (
      [
        ["today", "Today", "home"],
        ...(store.plan ? [["session", "Session", "play"]] : []),
        ["teach", "Teach", "graduation"],
        ["library", "Library", "book"],
        ["mistakes", "Mistakes", "flag"],
      ] as [View["name"], string, string][]
    ),
  );

  function go(name: View["name"]) {
    store.view = { name } as View;
  }
</script>

<nav class="rail" aria-label="Claude Tutor">
  <div class="items">
    {#each items as [name, label, icon] (name)}
      <button class="item" class:active={v === name} aria-current={v === name ? "page" : undefined} title={label} onclick={() => go(name)}>
        <span class="ico">
          <Icon name={icon} size={18} />
          {#if name === "session"}<span class="live"></span>{/if}
          {#if name === "mistakes" && store.mistakes.length}<span class="count">{store.mistakes.length}</span>{/if}
        </span>
        <span class="label">{label}</span>
      </button>
    {/each}
  </div>

  <div class="bottom">
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
    <button class="item" title="Claude Tutor settings" onclick={() => api.openSettings()}>
      <span class="ico"><Icon name="settings" size={18} /></span>
      <span class="label">Settings</span>
    </button>
  </div>
</nav>

<style>
  .rail {
    flex: none;
    width: 168px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 8px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .items,
  .bottom {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    font-weight: 550;
    font-size: 0.9em;
    color: var(--text-2);
    text-align: left;
    white-space: nowrap;
  }
  .item:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .item.active {
    background: var(--surface-2);
    color: var(--text);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .ico {
    position: relative;
    display: flex;
    flex: none;
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    position: absolute;
    top: -6px;
    right: -9px;
    min-width: 16px;
    background: var(--bad);
    color: var(--accent-text);
    font-size: 0.68em;
    font-weight: 700;
    line-height: 16px;
    padding: 0 4px;
    border-radius: 99px;
    text-align: center;
  }
  .live {
    position: absolute;
    top: -2px;
    right: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.8em;
    color: var(--text-2);
    padding: 5px 10px;
    margin-bottom: 4px;
    border-radius: 8px;
    background: var(--surface-2);
    text-align: left;
  }
  .chip .label {
    white-space: normal;
  }
  .chip.bad {
    color: var(--bad);
    background: var(--bad-soft);
  }
  /* Narrow (e.g. in Obsidian's sidebar): icons only; labels stay for screen readers. */
  @container (max-width: 560px) {
    .rail {
      width: 52px;
      padding: 10px 6px;
    }
    .item,
    .chip {
      justify-content: center;
      padding: 8px 0;
    }
    .label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  }
</style>
