<script lang="ts">
  import { onMount } from "svelte";
  import { Menu } from "obsidian";
  import { store, isDue } from "../lib/store.svelte";
  import { masteryColor, masteryLevel, relativeDue, timeAgo } from "../lib/util";
  import Icon from "./Icon.svelte";
  import Ring from "./Ring.svelte";
  import Markdown from "./Markdown.svelte";
  import type { Concept, NoteInfo } from "../lib/api";

  type Item = { note: NoteInfo; concepts: Concept[] };
  type Row = { kind: "note"; id: string; item: Item } | { kind: "pdf"; id: string; title: string; parts: Item[] };

  type Filter = "all" | "due" | "new" | "shaky" | "getting" | "solid";
  type Sort = "notes" | "due" | "weakest";
  const FILTERS: [Filter, string][] = [
    ["all", "All"],
    ["due", "Due"],
    ["new", "New"],
    ["shaky", "Shaky"],
    ["getting", "Getting there"],
    ["solid", "Solid"],
  ];

  let query = $state("");
  let filter = $state<Filter>("all");
  let sort = $state<Sort>("notes");
  let open = $state<Record<string, boolean>>({});
  let openGroups = $state<Record<string, boolean>>({});
  let searchEl = $state<HTMLInputElement>();
  /** The concept whose details are open (one at a time). */
  let detail = $state<number | null>(null);

  // Focus search when you switch to the tab (not via autofocus, which can steal focus from the editor).
  onMount(() => searchEl?.focus({ preventScroll: true }));

  const level = masteryLevel;
  function matches(c: Concept) {
    if (filter === "all") return true;
    if (filter === "due") return isDue(c);
    return level(c) === filter;
  }
  const counts = $derived(
    Object.fromEntries(
      FILTERS.map(([f]) => [f, f === "all" ? store.concepts.length : store.concepts.filter((c) => (f === "due" ? isDue(c) : level(c) === f)).length]),
    ) as Record<Filter, number>,
  );

  const q = $derived(query.trim().toLowerCase());
  /** Expand everything while searching or filtering, so matches are visible. */
  const narrowed = $derived(!!q || filter !== "all");
  const groups = $derived(
    store.notes
      .map((n) => {
        const concepts = store.concepts.filter((c) => c.note_path === n.key && matches(c));
        const noteHit = !q || n.title.toLowerCase().includes(q);
        const shown = noteHit ? concepts : concepts.filter((c) => c.name.toLowerCase().includes(q));
        const visible = filter === "all" ? noteHit || shown.length > 0 : shown.length > 0;
        return { note: n, concepts: shown, visible };
      })
      .filter((g) => g.visible),
  );

  /** Sort key for a row's concepts: lower comes first. */
  function rank(cs: Concept[]): number {
    if (sort === "due") {
      const due = cs.filter((c) => isDue(c));
      return due.length ? -due.length : 1;
    }
    const seen = cs.filter((c) => c.last_reviewed);
    return seen.length ? Math.min(...seen.map((c) => c.mastery)) : 2;
  }
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
    if (sort === "notes") return out;
    const all = (r: Row) => (r.kind === "pdf" ? r.parts.flatMap((p) => p.concepts) : r.item.concepts);
    return out
      .map((r, i) => ({ r, i, k: rank(all(r)) }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.r);
  });
  const skipped = $derived(store.snap?.skipped ?? []);

  function partLabel(n: NoteInfo) {
    if (!n.pages) return n.title;
    const [a, b] = n.pages;
    return a === b ? `Page ${a}` : `Pages ${a}–${b}`;
  }
  const activeConcept = $derived(store.plan ? store.currentConceptId : null);
  const activeNote = $derived(activeConcept !== null ? store.concept(activeConcept)?.note_path : undefined);

  function noteMenu(g: Item, e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => store.openNote(g.note.key)));
    if (g.concepts.length) menu.addItem((i) => i.setTitle("Quiz me on this").setIcon("zap").onClick(() => store.noteQuiz(g.note.key)));
    if (g.note.stale && !store.indexing) menu.addItem((i) => i.setTitle("Have Clawd read it now").setIcon("sparkles").onClick(() => void store.indexOne(g.note.key)));
    if (e.type === "contextmenu" || e.detail > 0) menu.showAtMouseEvent(e);
    else {
      // Opened from the keyboard: anchor to the button.
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      menu.showAtPosition({ x: r.left, y: r.bottom });
    }
    e.preventDefault();
  }
</script>

{#snippet noteItem(g: Item, label: string)}
  {@const expanded = open[g.note.key] ?? (narrowed || activeNote === g.note.key)}
  <div class="note" class:current={activeNote === g.note.key} oncontextmenu={(e) => noteMenu(g, e)} role="group" aria-label={label}>
    <button class="note-head" aria-expanded={expanded} onclick={() => (open[g.note.key] = !expanded)}>
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
      {#if g.concepts.length}
        <button class="quiz" title="Quiz me on this" onclick={() => store.noteQuiz(g.note.key)}><Icon name="zap" size={14} /><span>Quiz</span></button>
      {/if}
      <button title="More actions" aria-label="More actions for {label}" aria-haspopup="menu" onclick={(e) => noteMenu(g, e)}
        ><Icon name="more" size={16} /></button
      >
    </div>
  </div>
  {#if expanded}
    <ul>
      {#each g.concepts as c (c.id)}
        <li>
          <button
            class="concept"
            class:active={activeConcept === c.id}
            class:open={detail === c.id}
            aria-current={activeConcept === c.id ? "step" : undefined}
            aria-expanded={detail === c.id}
            aria-controls="concept-{c.id}"
            onclick={() => (detail = detail === c.id ? null : c.id)}
          >
            <Ring value={c.mastery} size={14} width={2.5} color={masteryColor(c)} empty={!c.last_reviewed} />
            <span><Markdown md={c.name} inline /></span>
          </button>
          {#if detail === c.id}
            {@render conceptDetail(c)}
          {/if}
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

{#snippet conceptDetail(c: Concept)}
  {@const mistakes = store.mistakes.filter((m) => m.concept_id === c.id)}
  <div class="detail" id="concept-{c.id}">
    {#if c.summary}<div class="d-summary"><Markdown md={c.summary} /></div>{/if}
    {#if c.excerpt}<blockquote class="d-excerpt"><Markdown md={c.excerpt} /></blockquote>{/if}
    <dl class="d-facts">
      <div>
        <dt>Mastery</dt>
        <dd style:color={masteryColor(c)}>{c.last_reviewed ? `${Math.round(c.mastery * 100)}%` : "Not studied yet"}</dd>
      </div>
      {#if c.last_reviewed}
        <div><dt>Last studied</dt><dd>{timeAgo(c.last_reviewed)}</dd></div>
        <div><dt>Next review</dt><dd>{relativeDue(c)}</dd></div>
      {/if}
      {#if c.lapses}<div><dt>Forgotten</dt><dd>{c.lapses}×</dd></div>{/if}
    </dl>
    {#if c.prerequisites.length}
      <p class="d-pre faint small">Builds on: {c.prerequisites.join(", ")}</p>
    {/if}
    {#if mistakes.length}
      <div class="d-mistakes">
        <p class="faint small">Open mistakes</p>
        <ul>{#each mistakes as m (m.id)}<li><Icon name="alert" size={13} /><span><Markdown md={m.text} inline /></span></li>{/each}</ul>
      </div>
    {/if}
    <div class="d-actions">
      <button class="btn sm primary" onclick={() => store.startExplain(c.id)}><Icon name="brain" size={14} />Explain it</button>
      <button class="btn sm" onclick={() => store.startQuiz(`Quiz: ${c.name}`, [c.id], 3)}><Icon name="zap" size={14} />Quiz me</button>
      <button class="btn sm ghost" onclick={() => store.openNote(c.note_path)}><Icon name="book" size={14} />Open note</button>
    </div>
  </div>
{/snippet}

<aside class="library">
  <header class="head">
    <h2>Library</h2>
    <p class="muted small">{store.notes.length} notes · {store.concepts.length} concepts · click a concept for details</p>
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
    <input type="search" placeholder="Search notes & concepts" aria-label="Search notes and concepts" bind:value={query} bind:this={searchEl} />
    <select class="sort" aria-label="Sort notes" bind:value={sort}>
      <option value="notes">Note order</option>
      <option value="due">Most due first</option>
      <option value="weakest">Weakest first</option>
    </select>
  </div>
  <div class="filters" role="radiogroup" aria-label="Show concepts">
    {#each FILTERS as [id, label] (id)}
      <button role="radio" aria-checked={filter === id} class:sel={filter === id} disabled={id !== "all" && !counts[id]} onclick={() => (filter = id)}
        >{label}<span class="fc">{counts[id]}</span></button
      >
    {/each}
  </div>

  <div class="list">
    {#each rows as r (r.id)}
      {#if r.kind === "pdf"}
        {@const gOpen = openGroups[r.id] ?? (narrowed || r.parts.some((p) => p.note.key === activeNote))}
        <button class="group-head" aria-expanded={gOpen} onclick={() => (openGroups[r.id] = !gOpen)}>
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
      <p class="none">
        {#if q}Nothing matches "{query}"{filter !== "all" ? " with this filter" : ""}.
        {:else if filter !== "all"}No {FILTERS.find(([f]) => f === filter)?.[1].toLowerCase()} concepts right now.
        {:else}No readable notes yet.{/if}
      </p>
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
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 4px;
    opacity: 0.45;
  }
  .note:hover .note-actions,
  .note:focus-within .note-actions,
  .note.current .note-actions {
    opacity: 1;
  }
  .note-actions .quiz {
    gap: 4px;
    align-items: center;
    font-size: 0.8rem;
    padding: 2px 8px;
    display: none;
  }
  .note:hover .note-actions .quiz,
  .note:focus-within .note-actions .quiz {
    display: flex;
  }
  .note.current {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .sort {
    font-size: 0.82em;
    background: transparent;
    border: 0;
    color: var(--text-2);
    box-shadow: none;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: -4px 12px 8px;
  }
  .filters button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.8rem;
    padding: 2px 10px;
    border-radius: 99px;
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .filters button.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .filters button:disabled {
    opacity: 0.4;
  }
  .fc {
    font-size: 0.85em;
    color: var(--text-3);
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
  li > button.concept {
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
  li > button.concept:hover,
  li > button.concept.open {
    background: var(--surface-2);
    color: var(--text);
  }
  li > button.concept.active {
    background: var(--accent-soft);
    color: var(--text);
  }
  li > button.concept span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    margin: 2px 0 8px 8px;
    padding: 10px 12px;
    border-left: 2px solid var(--border-strong);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.86rem;
  }
  .d-excerpt {
    margin: 0;
    padding-left: 10px;
    border-left: 3px solid var(--accent-soft);
    color: var(--text-2);
  }
  .d-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 0;
  }
  .d-facts dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
  }
  .d-facts dd {
    margin: 0;
    font-weight: 600;
  }
  .d-mistakes ul {
    padding: 0;
    margin: 4px 0 0;
  }
  .d-mistakes li {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    color: var(--text-2);
  }
  .d-mistakes li :global(svg) {
    flex: none;
    margin-top: 3px;
    color: var(--warn);
  }
  .d-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
