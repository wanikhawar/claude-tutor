<!-- First run: pick which folders Clawd should teach from. -->
<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import Clawd from "./Clawd.svelte";
  import Icon from "./Icon.svelte";

  const folders = api.folderSummary().filter((f) => f.count > 0);
  let query = $state("");
  let chosen = $state<string[]>([]);
  const shown = $derived(folders.filter((f) => f.path.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 200));
  const total = $derived.by(() => {
    // Don't double-count folders nested inside other chosen folders.
    const top = chosen.filter((c) => !chosen.some((o) => o !== c && (o === "/" || c.startsWith(o + "/"))));
    return top.reduce((n, p) => n + (folders.find((f) => f.path === p)?.count ?? 0), 0);
  });

  function toggle(path: string) {
    chosen = chosen.includes(path) ? chosen.filter((p) => p !== path) : [...chosen, path];
  }

  async function start() {
    await store.configure(chosen);
  }
</script>

<div class="setup">
  <Clawd mood="encouraging" size={120} onpoke={() => store.say("proud", "Pick a folder and I'll teach it back to you!")} />
  <h1>What should Clawd teach you?</h1>
  <p class="muted lede">
    Choose the folders with your study notes. Then pick which Markdown notes and PDFs in them Clawd should read, and
    learn them by explaining them back in your own words.
  </p>

  <div class="picker ct-card">
    <div class="search">
      <Icon name="search" size={16} />
      <input type="search" placeholder="Filter folders" bind:value={query} />
    </div>
    <div class="list">
      {#each shown as f (f.path)}
        <label class="row" class:sel={chosen.includes(f.path)}>
          <input type="checkbox" checked={chosen.includes(f.path)} onchange={() => toggle(f.path)} />
          <Icon name="folder" size={16} />
          <span class="path">{f.path === "/" ? "Whole vault" : f.path}</span>
          <span class="n">{f.count}</span>
        </label>
      {:else}
        <p class="faint small empty">No folders with notes found.</p>
      {/each}
    </div>
  </div>

  <div class="go">
    <span class="muted small">
      {#if total}{total} file{total > 1 ? "s" : ""} · next you pick which ones Clawd reads (one Claude request per note){/if}
    </span>
    <button class="btn primary lg" disabled={!chosen.length} onclick={start}>Start learning<Icon name="arrow" size={16} /></button>
  </div>
  <div class="or"><span>or</span></div>
  <button class="btn" onclick={() => store.pickNote()}><Icon name="file" size={16} />Add individual notes or PDFs</button>
  <p class="faint small">
    You can also right-click any note → <b>Quiz me on this</b>. Add or remove folders and notes anytime from the Library tab.
  </p>
</div>

<style>
  .setup {
    margin: auto;
    width: 100%;
    max-width: 620px;
    padding: 32px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
  }
  h1 {
    font-size: 1.6em;
  }
  .lede {
    max-width: 520px;
  }
  .picker {
    width: 100%;
    text-align: left;
    overflow: hidden;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text-3);
  }
  .search input {
    flex: 1;
    border: 0;
    background: none;
    box-shadow: none;
    padding: 10px 0;
  }
  .list {
    max-height: 300px;
    overflow: auto;
    padding: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--r-sm);
    cursor: pointer;
    color: var(--text-2);
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row.sel {
    background: var(--accent-soft);
    color: var(--text);
  }
  .row input {
    margin: 0;
  }
  .path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    font-size: 0.8em;
    color: var(--text-3);
  }
  .empty {
    padding: 12px;
  }
  .or {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    color: var(--text-3);
    font-size: 0.8em;
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .go {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
</style>
