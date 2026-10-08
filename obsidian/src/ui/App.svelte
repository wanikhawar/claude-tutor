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

  {#if store.error}
    <div class="toast card" role="alert">
      <span class="toast-icon"><Icon name="alert" /></span>
      <p>{store.error}</p>
      <button class="btn ghost icon sm" aria-label="Dismiss" onclick={() => (store.error = null)}><Icon name="x" /></button>
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
  .toast {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 10px 10px 14px;
    width: max-content;
    max-width: calc(100% - 24px);
    box-shadow: var(--shadow-lg);
    border-color: var(--bad);
  }
  .toast p {
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
