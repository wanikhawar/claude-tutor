<!--
  Model and effort switches. Use Obsidian's native menus.
-->
<script lang="ts">
  import { Menu } from "obsidian";
  import { store } from "../lib/store.svelte";
  import { EFFORT_CHOICES, MODEL_CHOICES } from "../../settings";
  import Icon from "./Icon.svelte";

  const model = $derived(store.snap?.model ?? "sonnet");
  const effort = $derived(store.snap?.effort ?? "");
  const names = $derived(store.snap?.modelNames ?? {});
  const effortName = $derived(EFFORT_CHOICES.find((e) => e.id === effort)?.name ?? effort);

  function addModels(menu: Menu) {
    menu.addItem((i) => i.setTitle("Tutor model").setIsLabel(true));
    for (const m of MODEL_CHOICES) {
      menu.addItem((i) =>
        i
          .setTitle(`${names[m.id] ?? m.id}: ${m.hint}`)
          .setChecked(model === m.id)
          .onClick(() => void store.setModel(m.id)),
      );
    }
  }

  function addEffort(menu: Menu) {
    menu.addItem((i) => i.setTitle("Effort").setIsLabel(true));
    for (const x of EFFORT_CHOICES) {
      menu.addItem((i) =>
        i
          .setTitle(`${x.name}: ${x.hint}`)
          .setChecked(effort === x.id)
          .onClick(() => void store.setEffort(x.id)),
      );
    }
  }

  /** Open at the pointer, or under the button when opened from the keyboard. */
  function show(menu: Menu, e: MouseEvent) {
    if (e.detail > 0) return menu.showAtMouseEvent(e);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom });
  }

  function open(e: MouseEvent, which: "model" | "effort") {
    const menu = new Menu();
    if (which === "model") addModels(menu);
    else addEffort(menu);
    show(menu, e);
  }
</script>

<button type="button" class="pick model" title="Change the tutor model" aria-haspopup="menu" onclick={(e) => open(e, "model")}>
  {names[model] ?? model}
</button>
<button type="button" class="pick" title="How hard Claude thinks" aria-haspopup="menu" onclick={(e) => open(e, "effort")}>
  {effort ? effortName : "Effort"}
</button>

<style>
  .pick {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 4px;
    border-radius: 4px;
    font-size: 0.85em;
    color: var(--text-2);
    white-space: nowrap;
  }
  .pick:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .model {
    color: var(--text);
  }
</style>
