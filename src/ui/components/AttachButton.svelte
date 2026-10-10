<!-- Attach images: upload from the computer or pick one from the vault. (Paste and drop work too.) -->
<script lang="ts">
  import { Menu } from "obsidian";
  import { obsidianApp } from "../lib/api";
  import type { Attachments } from "../lib/attachments.svelte";
  import { IMAGE_EXTS } from "../lib/images";
  import { ImagePicker } from "../lib/pickers";
  import Icon from "./Icon.svelte";

  // The attachments belong to the conversation, so switching composers never loses one.
  let { attachments }: { attachments: Attachments } = $props();
  let input = $state<HTMLInputElement>();

  function open(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Upload image…").setIcon("upload").onClick(() => input?.click()));
    menu.addItem((i) =>
      i
        .setTitle("Image from vault…")
        .setIcon("image")
        .onClick(() =>
          new ImagePicker(obsidianApp(), IMAGE_EXTS, (f) => attachments.addFromVault(obsidianApp(), f)).open(),
        ),
    );
    menu.addItem((i) => i.setTitle("Tip: you can also paste or drop images").setIsLabel(true));
    menu.showAtMouseEvent(e);
  }
</script>

<input
  bind:this={input}
  type="file"
  accept="image/*"
  multiple
  hidden
  onchange={async () => {
    if (input?.files) await attachments.add([...input.files]);
    if (input) input.value = "";
  }}
/>
<button type="button" class="attach" title="Attach an image of your work" aria-label="Attach image" onclick={open}>
  <Icon name="plus" size={22} stroke={1.7} />{#if attachments.images.length}<span class="n">{attachments.images.length}</span>{/if}
</button>
{#if attachments.preparing}<span class="preparing" role="status">Preparing image…</span>{/if}

<style>
  .attach {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    color: var(--text-2);
  }
  .attach:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .preparing {
    color: var(--text-3);
    font-size: 0.82em;
    white-space: nowrap;
  }
  .n {
    position: absolute;
    top: 0;
    right: 0;
    background: var(--surface);
    border-radius: 4px;
    padding: 0 3px;
    font-size: 0.75em;
    font-weight: 700;
  }
</style>
