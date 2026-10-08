<!-- Model and effort switches shown in the composer. Use Obsidian's native menus. -->
<script lang="ts">
  import { Menu } from "obsidian";
  import { store } from "../lib/store.svelte";
  import { EFFORT_CHOICES, MODEL_CHOICES } from "../../settings";

  const model = $derived(store.snap?.model ?? "sonnet");
  const effort = $derived(store.snap?.effort ?? "");
  const names = $derived(store.snap?.modelNames ?? {});
  const effortName = $derived(EFFORT_CHOICES.find((e) => e.id === effort)?.name ?? effort);

  function openModels(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Tutor model").setIsLabel(true));
    for (const m of MODEL_CHOICES) {
      menu.addItem((i) =>
        i
          .setTitle(`${names[m.id] ?? m.id}: ${m.hint}`)
          .setChecked(model === m.id)
          .onClick(() => void store.setModel(m.id)),
      );
    }
    menu.showAtMouseEvent(e);
  }

  function openEffort(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Effort").setIsLabel(true));
    for (const x of EFFORT_CHOICES) {
      menu.addItem((i) =>
        i
          .setTitle(`${x.name}: ${x.hint}`)
          .setChecked(effort === x.id)
          .onClick(() => void store.setEffort(x.id)),
      );
    }
    menu.showAtMouseEvent(e);
  }
</script>

<button type="button" class="pick model" title="Change the tutor model" onclick={openModels}>
  {names[model] ?? model}
</button>
<button type="button" class="pick" title="How hard Claude thinks" onclick={openEffort}>
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
