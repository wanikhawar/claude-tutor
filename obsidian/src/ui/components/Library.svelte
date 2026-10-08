<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { masteryColor } from "../lib/util";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";
  import Markdown from "./Markdown.svelte";
  import type { Concept, NoteInfo } from "../lib/api";

  type Item = { note: NoteInfo; concepts: Concept[] };
  type Row = { kind: "note"; id: string; item: Item } | { kind: "pdf"; id: string; title: string; parts: Item[] };

  let query = $state("");
  let open = $state<Record<string, boolean>>({});
  let openGroups = $state<Record<string, boolean>>({});


  const q = $derived(query.trim().toLowerCase());
  const groups = $derived(
    store.notes
      .map((n) => {
        const concepts = store.concepts.filter((c) => c.note_path === n.key);
        const noteHit = !q || n.title.toLowerCase().includes(q);
        const shown = noteHit ? concepts : concepts.filter((c) => c.name.toLowerCase().includes(q));
        return { note: n, concepts: shown, visible: noteHit || shown.length > 0 };
      })
      .filter((g) => g.visible),
  );
  // Parts of a split PDF are listed under one entry for the file.
  const rows = $derived.by(() => {
    const out: Row[] = [];
    const byGroup = new Map<string, Row & { kind: "pdf" }>();
    for (const g of groups) {
      const grp = g.note.group;
      if (!grp) {
        out.push({ kind: "note", id: g.note.key, item: g });
        continue;
      }
      let row = byGroup.get(grp);
      if (!row) {
        row = { kind: "pdf", id: grp, title: grp.split("/").pop()!.replace(/\.pdf$/i, ""), parts: [] };
        byGroup.set(grp, row);
        out.push(row);
      }
      row.parts.push(g);
    }
    return out;
  });
  const skipped = $derived(store.snap?.skipped ?? []);

  function partLabel(n: NoteInfo) {
    if (!n.pages) return n.title;
    const [a, b] = n.pages;
    return a === b ? `Page ${a}` : `Pages ${a}–${b}`;
  }
  const activeConcept = $derived(
    store.view.name === "session" && store.plan?.steps.length === 1 && store.plan.steps[0].kind === "explain"
      ? store.plan.steps[0].conceptId
      : null,
  );
</script>

{#snippet noteItem(g: Item, label: string)}
  {@const expanded = open[g.note.key] ?? !!q}
  <div class="note" class:current={false}>
    <button class="note-head" onclick={() => (open[g.note.key] = !expanded)}>
      <span class="chev" class:expanded><Icon name="right" size={14} /></span>
      <span class="title">{label}</span>
      {#if g.note.kind === "pdf" && !g.note.group}<span class="badge">PDF</span>{/if}
      {#if g.note.stale}
        <span class="tag" title="Clawd hasn't read this version yet">{g.concepts.length ? "updated" : "new"}</span>
      {:else}
        <span class="n">{g.concepts.length}</span>
      {/if}
    </button>
    <div class="note-actions">
      <button title="Open in Obsidian" aria-label="Open note" onclick={() => store.openNote(g.note.key)}
        ><Icon name="book" size={15} /></button
      >
      {#if g.note.stale && !store.indexing}
        <button title="Have Clawd read it now" aria-label="Read now" onclick={() => store.indexOne(g.note.key)}
          ><Icon name="sparkles" size={15} /></button
        >
      {/if}
      {#if g.concepts.length}
        <button title="Quiz me on this" aria-label="Quiz this" onclick={() => store.noteQuiz(g.note.key)}
          ><Icon name="zap" size={15} /></button
        >
      {/if}
    </div>
  </div>
  {#if expanded}
    <ul>
      {#each g.concepts as c (c.id)}
        <li>
          <button class:active={activeConcept === c.id} title={c.summary} onclick={() => store.startExplain(c.id)}>
            <Ring value={c.mastery} size={14} width={2.5} color={masteryColor(c)} empty={!c.last_reviewed} />
            <span><Markdown md={c.name} inline /></span>
          </button>
        </li>
      {:else}
        <li class="empty">
          {#if g.note.stale}
            {store.indexing?.current === g.note.title ? "Clawd is reading this…" : "Not read yet."}
            {#if !store.indexing}<button class="link" onclick={() => store.indexOne(g.note.key)}>Read it now</button>{/if}
          {:else}No concepts found.{/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<aside class="library">
  <header class="head">
    <h2>Library</h2>
    <p class="muted small">{store.notes.length} notes · {store.concepts.length} concepts · click a concept to explain it</p>
    <div class="sources">
      {#each store.snap?.sources.folders ?? [] as f (f)}
        <span class="src" title="Folder: {f}">
          <Icon name="folder" size={13} />{f === "/" ? "Whole vault" : f}
          <button aria-label="Remove {f}" title="Remove from library" onclick={() => store.removeSource(f)}><Icon name="x" size={12} /></button>
        </span>
      {/each}
      {#each store.snap?.sources.files ?? [] as f (f)}
        <span class="src" title="Note: {f}">
          <Icon name="file" size={13} />{f.split("/").pop()}
          <button aria-label="Remove {f}" title="Remove from library" onclick={() => store.removeSource(f)}><Icon name="x" size={12} /></button>
        </span>
      {/each}
      <button class="btn sm" onclick={() => store.pickNote()}><Icon name="file" size={14} />Add note or PDF</button>
      <button class="btn sm ghost" onclick={() => store.pickFolder()}><Icon name="folder" size={14} />Add folder</button>
    </div>
  </header>
  <div class="search">
    <Icon name="search" size={16} />
    <!-- svelte-ignore a11y_autofocus -->
    <input type="search" placeholder="Search notes & concepts" bind:value={query} autofocus />
  </div>

  <div class="list">
    {#each rows as r (r.id)}
      {#if r.kind === "pdf"}
        {@const gOpen = openGroups[r.id] ?? (!!q || false)}
        <button class="group-head" onclick={() => (openGroups[r.id] = !gOpen)}>
          <span class="chev" class:expanded={gOpen}><Icon name="right" size={14} /></span>
          <span class="title">{r.title}</span>
          <span class="badge">PDF</span>
          <span class="n">{r.parts.reduce((n, p) => n + p.concepts.length, 0)}</span>
        </button>
        {#if gOpen}
          <div class="group-body">
            {#each r.parts as item (item.note.key)}{@render noteItem(item, partLabel(item.note))}{/each}
          </div>
        {/if}
      {:else}
        {@render noteItem(r.item, r.item.note.title)}
      {/if}
    {:else}
      <p class="none">{q ? `Nothing matches "${query}".` : "No readable notes yet."}</p>
    {/each}
  </div>

  {#if skipped.length}
    <details class="skipped">
      <summary><Icon name="alert" size={14} />{skipped.length} file{skipped.length > 1 ? "s" : ""} couldn't be read</summary>
      <ul>
        {#each skipped as f}<li><b>{f.rel}</b><span>{f.reason}</span></li>{/each}
      </ul>
    </details>
  {/if}

  <div class="legend">
    <span><Ring value={0} size={11} width={2} empty />new</span>
    <span><Ring value={0.3} size={11} width={2} color="var(--bad)" />shaky</span>
    <span><Ring value={0.6} size={11} width={2} color="var(--warn)" />getting there</span>
    <span><Ring value={1} size={11} width={2} color="var(--good)" />solid</span>
  </div>
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 820px;
    margin: 0 auto;
    min-height: 0;
    flex: 1;
    padding: 20px 12px 0;
  }
  .head {
    padding: 0 12px;
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin: 12px 0 4px;
  }
  .src {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.82em;
    padding: 3px 4px 3px 9px;
    border-radius: 99px;
    background: var(--surface-2);
    color: var(--text-2);
    max-width: 260px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .src button {
    display: flex;
    padding: 2px;
    border-radius: 50%;
    color: var(--text-3);
  }
  .src button:hover {
    color: var(--bad);
    background: var(--bad-soft);
  }
  .link {
    color: var(--accent);
    margin-left: 4px;
  }
  .search {
    margin: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text-3);
  }
  .search input {
    flex: 1;
    border: 0;
    background: none;
    padding: 8px 0;
    box-shadow: none;
    min-width: 0;
  }
  .list {
    flex: 1;
    overflow: auto;
    padding: 0 8px 12px;
  }
  .note {
    display: flex;
    align-items: center;
    border-radius: var(--r-sm);
  }
  .note:hover,
  .note.current {
    background: var(--surface-2);
  }
  .note-head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: none;
    padding: 7px 6px;
    cursor: pointer;
    text-align: left;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    color: var(--text-3);
    display: flex;
    transition: transform 0.15s;
  }
  .chev.expanded {
    transform: rotate(90deg);
  }
  .n {
    font-size: 0.75rem;
    color: var(--text-3);
  }
  .tag {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 1px 6px;
    border-radius: 99px;
  }
  .note-actions {
    display: none;
    padding-right: 4px;
  }
  .note:hover .note-actions {
    display: flex;
  }
  .note-actions button {
    border: 0;
    background: none;
    color: var(--text-2);
    padding: 4px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
  }
  .note-actions button:hover {
    color: var(--accent);
    background: var(--surface-3);
  }
  ul {
    list-style: none;
    margin: 0 0 6px;
    padding: 0 0 0 18px;
  }
  li button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    border: 0;
    background: none;
    text-align: left;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: 0.88rem;
    color: var(--text-2);
  }
  li button:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  li button.active {
    background: var(--accent-soft);
    color: var(--text);
  }
  li button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty,
  .none {
    font-size: 0.82rem;
    color: var(--text-3);
    padding: 4px 8px;
  }
  .group-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: none;
    padding: 7px 6px;
    border-radius: var(--r-sm);
    cursor: pointer;
    text-align: left;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .group-head:hover {
    background: var(--surface-2);
  }
  .group-body {
    padding-left: 14px;
    border-left: 1px solid var(--border);
    margin-left: 13px;
  }
  .group-body .note-head {
    font-weight: 500;
    color: var(--text-2);
  }
  .badge {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--bad);
    border: 1px solid currentColor;
    padding: 0 4px;
    border-radius: 4px;
    opacity: 0.8;
  }
  .skipped {
    margin: 0 12px 10px;
    font-size: 0.78rem;
    color: var(--text-2);
  }
  .skipped summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--warn);
  }
  .skipped ul {
    list-style: none;
    padding: 6px 0 0;
    display: grid;
    gap: 6px;
  }
  .skipped li {
    display: flex;
    flex-direction: column;
  }
  .skipped li span {
    color: var(--text-3);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    font-size: 0.72rem;
    color: var(--text-3);
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>
