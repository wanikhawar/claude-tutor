<script lang="ts">
  import { onMount } from "svelte";
  import type { ItemView } from "obsidian";
  import { store } from "./lib/store.svelte";
  import TopBar from "./components/TopBar.svelte";
  import Setup from "./components/Setup.svelte";
  import Today from "./components/Today.svelte";
  import Session from "./components/Session.svelte";
  import Mistakes from "./components/Mistakes.svelte";
  import Library from "./components/Library.svelte";
  import Teach from "./components/Teach.svelte";
  import Icon from "./components/Icon.svelte";
  import Clawd from "./components/Clawd.svelte";

  // The hosting Obsidian view (available for future use, e.g. view-scoped events).
  let { component: _view }: { component: ItemView } = $props();

  onMount(() => {
    void store.refresh();
  });

  // Errors clear themselves after a while; hovering keeps one up while you read it.
  let hoverError = $state(false);
  $effect(() => {
    const err = store.error;
    if (!err || hoverError) return;
    const t = setTimeout(() => {
      if (store.error === err) store.error = null;
    }, 10_000);
    return () => clearTimeout(t);
  });

  let dialogEl = $state<HTMLDivElement>();
  $effect(() => {
    // A selector list matches in document order, so look for the primary button first.
    if (store.dialog) (dialogEl?.querySelector<HTMLButtonElement>("button.primary") ?? dialogEl?.querySelector<HTMLButtonElement>("button"))?.focus();
  });

  function dialogKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      store.answer(null);
    } else if (e.key === "Tab" && dialogEl) {
      // Keep focus inside the dialog.
      const items = [...dialogEl.querySelectorAll<HTMLButtonElement>("button")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
      e.preventDefault();
      items[next]?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ct-root" onpointerdown={() => store.poke()} onkeydown={() => store.poke()}>
  {#if !store.snap}
    <div class="boot"><Clawd mood="thinking" size={88} /></div>
  {:else if !store.configured}
    <Setup />
  {:else}
    <TopBar />
    <main class="content">
      <!-- Session and Teach stay mounted while you visit other tabs, so you don't lose your place. -->
      {#if store.plan}
        <div class="keep" class:hidden={store.view.name !== "session"}>
          {#key store.plan.id}<Session plan={store.plan} />{/key}
        </div>
      {/if}
      <div class="keep" class:hidden={store.view.name !== "teach"}><Teach /></div>
      {#if store.view.name === "session" || store.view.name === "teach"}
        <!-- shown above -->
      {:else if store.view.name === "mistakes"}
        <Mistakes />
      {:else if store.view.name === "library"}
        <Library />
      {:else}
        <Today />
      {/if}
    </main>
  {/if}

  <div class="toasts">
    {#if store.error}
      <div
        class="ct-toast ct-card err"
        role="alert"
        onpointerenter={() => (hoverError = true)}
        onpointerleave={() => (hoverError = false)}
      >
        <span class="toast-icon"><Icon name="alert" /></span>
        <p>{store.error}</p>
        <button class="btn ghost icon sm" aria-label="Dismiss" onclick={() => (store.error = null)}><Icon name="x" /></button>
      </div>
    {/if}
    {#if store.toast}
      {#key store.toast.id}
        <div class="ct-toast ct-card" role="status">
          <p>{store.toast.text}</p>
          {#if store.toast.action}
            <button class="btn sm" onclick={() => store.runToastAction()}>{store.toast.action.label}</button>
          {/if}
          <button class="btn ghost icon sm" aria-label="Dismiss" onclick={() => (store.toast = null)}><Icon name="x" /></button>
        </div>
      {/key}
    {/if}
  </div>

  {#if store.dialog}
    {@const d = store.dialog}
    <div class="scrim" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && store.answer(null)}>
      <div
        class="dialog ct-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ct-dialog-title"
        aria-describedby="ct-dialog-body"
        tabindex="-1"
        bind:this={dialogEl}
        onkeydown={dialogKey}
      >
        <h3 id="ct-dialog-title">{d.title}</h3>
        <p id="ct-dialog-body" class="muted">{d.body}</p>
        <div class="dialog-actions">
          {#each d.choices as c (c.id)}
            <button class="btn" class:primary={c.primary && !c.danger} class:danger={c.danger} class:strong={c.primary} onclick={() => store.answer(c.id)}
              >{c.label}</button
            >
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ct-root {
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    container-type: inline-size;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .keep {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .keep.hidden {
    display: none;
  }
  .boot {
    flex: 1;
    display: grid;
    place-items: center;
  }
  /* Toasts sit at the top so they never cover the composer. */
  .toasts {
    position: absolute;
    left: 50%;
    top: 56px;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: calc(100% - 24px);
    pointer-events: none;
  }
  .ct-toast {
    pointer-events: auto;
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 10px 10px 14px;
    max-width: 100%;
    box-shadow: var(--shadow-lg);
    align-items: center;
  }
  .ct-toast.err {
    border-color: var(--bad);
    align-items: flex-start;
  }
  .ct-toast:not(.err) p {
    padding-top: 0;
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.35);
  }
  .dialog {
    width: min(440px, 100%);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: var(--shadow-lg);
  }
  .dialog:focus {
    outline: none;
  }
  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
  .dialog-actions .danger {
    color: var(--bad);
    border-color: var(--bad);
  }
  .dialog-actions .danger.strong {
    background: var(--bad);
    color: var(--accent-text);
  }
  .ct-toast p {
    flex: 1;
    padding-top: 5px;
    font-size: 0.9em;
    user-select: text;
  }
  .toast-icon {
    color: var(--bad);
    padding-top: 5px;
  }
</style>
