<!--
  One switch for the tutor model and effort. Opens a small popover: models on top,
  an effort slider (Faster → Smarter) below.
-->
<script lang="ts" module>
  let count = 0;
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { on } from "svelte/events";
  import { store } from "../lib/store.svelte";
  import { EFFORT_CHOICES } from "../../settings";
  import { PROVIDERS, type Provider } from "../../core/cli";
  import Icon from "./Icon.svelte";

  const LEVELS = EFFORT_CHOICES;
  const WIDTH = 200;
  // Obsidian turns every aria-label into a hover tooltip, so label by id instead.
  const uid = `ct-model-pick-${++count}`;

  const provider = $derived(store.snap?.provider ?? "claude");
  const model = $derived(store.snap?.model ?? "sonnet");
  const effort = $derived(store.snap?.effort ?? "medium");
  // The models you chose to show (Settings → Models), in your order.
  const models = $derived(store.snap?.models ?? []);
  const isCurrent = (m: { provider: Provider; id: string }) => m.provider === provider && m.id === model;
  const current = $derived(models.find(isCurrent)?.name ?? (model || "Default"));
  /** From this many models up, the list gets a search box. */
  const SEARCH_FROM = 8;
  const searchable = $derived(models.length >= SEARCH_FROM);
  let query = $state("");
  const shownModels = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : models;
  });
  // One section per CLI that has models to show; headings only once there's a choice of CLI.
  const groups = $derived(PROVIDERS.map((p) => ({ ...p, models: shownModels.filter((m) => m.provider === p.id) })).filter((g) => g.models.length));
  /** The options in the order they're drawn, for arrow keys. */
  const options = $derived(groups.flatMap((g) => g.models));
  /** The highlighted option (arrow keys, hover); Enter picks it. Not the same as the current model. */
  let active = $state(0);
  const activeAt = $derived(Math.min(active, options.length - 1));
  const optionId = (i: number) => `${uid}-option-${i}`;
  const effortName = (id: string) => EFFORT_CHOICES.find((e) => e.id === id)?.name ?? id;

  let open = $state(false);
  let pos = $state("");
  let btn = $state<HTMLButtonElement>();
  let pop = $state<HTMLDivElement>();
  let list = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();
  let track = $state<HTMLDivElement>();
  let rail = $state<HTMLDivElement>();
  /** Level index while dragging, so the store only hears about the final pick. */
  let drag = $state<number | null>(null);

  const index = $derived(drag ?? LEVELS.findIndex((e) => e.id === effort));
  const shown = $derived(index >= 0 ? LEVELS[index].name : effortName(effort));

  function place() {
    if (!btn) return;
    const win = btn.ownerDocument.defaultView ?? window;
    const r = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, win.innerWidth - WIDTH - 8));
    // Under the entry box there is rarely room below, so prefer opening upward.
    const up = r.top > win.innerHeight - r.bottom;
    // Never taller than the room on that side (less the gap and an 8px margin); it scrolls instead.
    const room = Math.max(0, (up ? r.top : win.innerHeight - r.bottom) - 6 - 8);
    pos = up
      ? `left:${left}px;bottom:${win.innerHeight - r.top + 6}px;max-height:${room}px`
      : `left:${left}px;top:${r.bottom + 6}px;max-height:${room}px`;
  }

  function toggle() {
    if (open) return close();
    place();
    query = "";
    active = Math.max(0, options.findIndex(isCurrent));
    open = true;
    queueMicrotask(() => {
      (search ?? list)?.focus();
      reveal();
    });
  }

  /**
   * An input method (Chinese, Japanese, …) is composing text: its Enter confirms the text
   * and its Esc cancels it. Some browsers flag only the keyCode on the confirming keydown.
   */
  const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;

  /** Keep the highlighted option in view inside the scrolling popover. */
  function reveal() {
    pop?.querySelector(`#${optionId(activeAt)}`)?.scrollIntoView({ block: "nearest" });
  }

  /** Arrow keys move the highlight through the list (from the search box too); Enter picks it. */
  function listKey(e: KeyboardEvent) {
    if (composing(e) || !options.length) return;
    if (e.key === "Enter" || (e.key === " " && e.currentTarget === list)) {
      e.preventDefault();
      return pickModel(options[activeAt]);
    }
    // In the search box, Home and End move the caret.
    if (e.currentTarget === search && (e.key === "Home" || e.key === "End")) return;
    const next = { ArrowDown: activeAt + 1, ArrowUp: activeAt - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    active = Math.max(0, Math.min(options.length - 1, next));
    void tick().then(reveal);
  }

  function close(refocus = false) {
    open = false;
    drag = null;
    if (refocus) btn?.focus();
  }

  /**
   * Move the popover to <body>. The view's container queries and the leaf's
   * `contain: strict` would otherwise turn `position: fixed` into "relative to the pane".
   * The ct-root class brings the theme tokens along.
   *
   * Svelte hands `onclick` and friends to listeners on the mount target and the main
   * document, and a pop-out window's body is neither. Listening on the popover itself
   * runs those handlers from here, in whichever window it's in. Svelte skips the
   * listening element's own handler, so the popover's keydown goes in directly.
   */
  function portal(node: HTMLElement) {
    (btn?.ownerDocument ?? document).body.appendChild(node);
    const off = [
      on(node, "keydown", popKey),
      ...["click", "input", "pointerdown", "pointermove", "pointerup", "pointercancel"].map((type) => on(node, type, () => {})),
    ];
    return {
      destroy: () => {
        for (const f of off) f();
        node.remove();
      },
    };
  }

  function pickModel(m: { provider: Provider; id: string }) {
    close(true);
    if (!isCurrent(m)) void store.setModel(m.provider, m.id);
  }

  function setLevel(i: number) {
    const id = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))].id;
    if (id !== effort) void store.setEffort(id);
  }

  function levelAt(e: PointerEvent): number {
    const r = rail!.getBoundingClientRect();
    const t = r.width ? (e.clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(LEVELS.length - 1, Math.round(t * (LEVELS.length - 1))));
  }

  function down(e: PointerEvent) {
    e.preventDefault();
    track?.setPointerCapture?.(e.pointerId);
    track?.focus();
    drag = levelAt(e);
  }

  function move(e: PointerEvent) {
    if (drag !== null) drag = levelAt(e);
  }

  function up() {
    if (drag === null) return;
    const i = drag;
    drag = null;
    setLevel(i);
  }

  function key(e: KeyboardEvent) {
    const at = Math.max(0, index);
    const next = { ArrowLeft: at - 1, ArrowDown: at - 1, ArrowRight: at + 1, ArrowUp: at + 1, Home: 0, End: LEVELS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setLevel(next);
  }

  function popKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Keep Esc from also cancelling a running request.
    e.stopPropagation();
    if (!composing(e)) close(true);
  }

  $effect(() => {
    if (!open || !btn) return;
    const win = btn.ownerDocument.defaultView ?? window;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop?.contains(t) && !btn?.contains(t)) close();
    };
    const reflow = () => close();
    win.addEventListener("pointerdown", outside, true);
    win.addEventListener("resize", reflow);
    return () => {
      win.removeEventListener("pointerdown", outside, true);
      win.removeEventListener("resize", reflow);
    };
  });
</script>

{#snippet mark(p: Provider, size: number)}
  {#if p === "codex"}
    <svg class="openai" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  {:else}
    {@render spark(size)}
  {/if}
{/snippet}

{#snippet spark(size: number)}
  <svg class="spark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
  </svg>
{/snippet}

<button
  bind:this={btn}
  id={uid}
  type="button"
  class="pick model"
  class:open
  title="Change the tutor model and effort"
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={toggle}
>
  {@render mark(provider, 15)}
  <span class="name">{current}</span>
  <span class="effort">· {effortName(effort)}</span>
  <span class="chev"><Icon name="down" size={14} /></span>
</button>

{#if open}
  <div bind:this={pop} use:portal class="ct-root ct-model-pop" role="dialog" aria-labelledby={uid} tabindex="-1" style={pos}>
    {#if searchable}
      <input
        bind:this={search}
        bind:value={query}
        class="search"
        type="text"
        placeholder="Search models"
        role="combobox"
        aria-label="Search models"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-autocomplete="list"
        aria-activedescendant={options.length ? optionId(activeAt) : undefined}
        oninput={() => (active = 0)}
        onkeydown={listKey}
      />
    {/if}
    <!-- The search box, when there is one, holds focus and points at the highlighted option instead. -->
    <div
      bind:this={list}
      id="{uid}-list"
      class="models"
      role="listbox"
      aria-label="Model"
      tabindex={searchable ? -1 : 0}
      aria-activedescendant={!searchable && options.length ? optionId(activeAt) : undefined}
      onkeydown={listKey}
    >
      {#each groups as g (g.id)}
        <div class="group" role="group" aria-labelledby={groups.length > 1 ? `${uid}-${g.id}` : undefined}>
          {#if groups.length > 1}<div class="group-name" id="{uid}-{g.id}">{g.name}</div>{/if}
          {#each g.models as m (m.id)}
            {@const i = options.indexOf(m)}
            <button
              type="button"
              id={optionId(i)}
              class="row"
              class:active={i === activeAt}
              role="option"
              tabindex="-1"
              aria-selected={isCurrent(m)}
              onpointerenter={() => (active = i)}
              onclick={() => pickModel(m)}
            >
              {@render mark(m.provider, 15)}
              <span class="label">{m.name}</span>
              {#if isCurrent(m)}<span class="tick"><Icon name="check" size={14} /></span>{/if}
            </button>
          {/each}
        </div>
      {/each}
      {#if !options.length}<div class="empty">No models match “{query.trim()}”.</div>{/if}
    </div>
    <div class="effort-box">
      <div class="effort-head">
        <span class="faint" id="{uid}-effort">Effort</span>
        <span class="value">{shown}</span>
      </div>
      <div class="ends faint"><span>Faster</span><span>Smarter</span></div>
      <div
        bind:this={track}
        class="track"
        role="slider"
        tabindex="0"
        aria-labelledby="{uid}-effort"
        aria-valuemin={0}
        aria-valuemax={LEVELS.length - 1}
        aria-valuenow={Math.max(0, index)}
        aria-valuetext={shown}
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={() => (drag = null)}
        onkeydown={key}
      >
        <div class="rail" bind:this={rail}>
          {#if index >= 0}
            <!-- The filled part of the meter, from the low end up to the thumb. -->
            <span class="fill" class:dragging={drag !== null} style="width:calc({(index / (LEVELS.length - 1)) * 100}% + 15px)"></span>
          {/if}
          {#each LEVELS as l, i}
            <span class="dot" style="left:{(i / (LEVELS.length - 1)) * 100}%" title={`${l.name}: ${l.hint}`}></span>
          {/each}
          {#if index >= 0}
            <span class="thumb" class:dragging={drag !== null} style="left:{(index / (LEVELS.length - 1)) * 100}%"></span>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .pick {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 6px;
    border-radius: 6px;
    font-size: 0.85em;
    color: var(--text);
    white-space: nowrap;
    /* A long model name truncates rather than pushing the button out of a narrow pane. */
    max-width: 100%;
    min-width: 0;
  }
  .pick:hover,
  .pick.open {
    background: var(--surface-2);
  }
  .pick .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }
  .pick .effort {
    flex: none;
    color: var(--text-2);
  }
  .chev {
    flex: none;
    display: inline-flex;
    color: var(--text-3);
    transition: transform 0.15s ease;
  }
  .pick:not(.open) .chev {
    transform: rotate(180deg);
  }
  .spark {
    flex: none;
    /* Claude's brand orange, as in the official symbol. */
    fill: #d97757;
  }

  .ct-model-pop {
    position: fixed;
    z-index: var(--layer-menu, 65);
    /* So max-height covers the padding and border too. */
    box-sizing: border-box;
    /* One scroll for the whole popover when the window is too short: every model and the slider stay reachable. */
    overflow-y: auto;
    width: 200px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg);
    box-shadow: var(--shadow-lg);
    white-space: normal;
    font-size: var(--font-ui-small);
  }
  .search {
    width: 100%;
    margin-bottom: 4px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--text);
    font-size: inherit;
  }
  .search:focus {
    border-color: var(--accent);
    outline: none;
  }
  .models {
    display: flex;
    flex-direction: column;
    padding-bottom: 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  /* Focus stays on the list (or the search box); the highlighted option carries the ring. */
  .models:focus {
    outline: none;
  }
  .models:focus-visible .row.active {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  .empty {
    padding: 6px 8px;
    color: var(--text-3);
  }
  .group-name {
    padding: 6px 8px 2px;
    color: var(--text-3);
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .openai {
    flex: none;
    fill: var(--codex);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: auto;
    padding: 5px 8px;
    border-radius: var(--r-sm);
    background: none;
    box-shadow: none;
    color: var(--text);
    text-align: left;
  }
  .row.active {
    background: var(--surface-2);
  }
  .row .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tick {
    display: inline-flex;
    color: var(--good);
  }
  .effort-box {
    padding: 8px 8px 6px;
  }
  .effort-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .effort-head .value {
    color: var(--text);
    font-weight: 600;
  }
  .ends {
    display: flex;
    justify-content: space-between;
    margin: 4px 0 6px;
    font-size: 0.85em;
  }
  .faint {
    color: var(--text-2);
  }
  .track {
    position: relative;
    height: 24px;
    /* Padding so the thumb's centre lands on the end dots. */
    padding: 0 15px;
    border-radius: 12px;
    background: var(--surface-3);
    cursor: pointer;
    touch-action: none;
  }
  .track:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
  }
  .rail {
    position: relative;
    height: 100%;
  }
  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    /* Starts at the track's rounded left edge, beyond the rail's padding. */
    left: -15px;
    border-radius: 12px;
    background: var(--meter-fill);
    transition: width 0.12s ease;
  }
  .fill.dragging {
    transition: none;
  }
  .dot {
    position: absolute;
    top: 50%;
    width: 4px;
    height: 4px;
    margin: -2px 0 0 -2px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 26px;
    height: 28px;
    margin: -14px 0 0 -13px;
    border-radius: 6px;
    background: #e8dcc4;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: left 0.12s ease;
  }
  .thumb.dragging {
    transition: none;
  }
</style>
