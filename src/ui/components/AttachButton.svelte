<!-- Attach images: upload from the computer or pick one from the vault. (Paste and drop work too.) -->
<script lang="ts">
  import { Menu } from "obsidian";
  import { obsidianApp } from "../lib/api";
  import { IMAGE_EXTS, MAX_IMAGES, fromVault, prepareImage, type Img } from "../lib/images";
  import { ImagePicker } from "../lib/pickers";
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";

  let { images = $bindable([]) }: { images: Img[] } = $props();
  let input = $state<HTMLInputElement>();
  // Bumped by `discardPending()`: images still being prepared are dropped instead of
  // landing in whatever the bound list holds by then.
  let epoch = 0;

  /** Drop images that are still being prepared (e.g. when the conversation is reset). */
  export function discardPending() {
    epoch++;
  }

  export async function add(files: Blob[], names: string[] = []) {
    const started = epoch;
    for (let i = 0; i < files.length; i++) {
      if (images.length >= MAX_IMAGES) {
        store.error = `You can attach up to ${MAX_IMAGES} images at a time.`;
        return;
      }
      try {
        // Read `images` only after the await so concurrent adds don't overwrite each other.
        const img = await prepareImage(files[i], names[i] ?? (files[i] as File).name ?? "image");
        if (epoch !== started) return;
        if (images.length >= MAX_IMAGES) {
          store.error = `You can attach up to ${MAX_IMAGES} images at a time.`;
          return;
        }
        images = [...images, img];
      } catch (e) {
        if (epoch !== started) return;
        store.error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  function open(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Upload image…").setIcon("upload").onClick(() => input?.click()));
    menu.addItem((i) =>
      i
        .setTitle("Image from vault…")
        .setIcon("image")
        .onClick(() =>
          new ImagePicker(obsidianApp(), IMAGE_EXTS, async (f) => {
            const started = epoch;
            if (images.length >= MAX_IMAGES) return void (store.error = `You can attach up to ${MAX_IMAGES} images.`);
            try {
              const img = await fromVault(obsidianApp(), f);
              if (epoch !== started) return;
              if (images.length >= MAX_IMAGES) return void (store.error = `You can attach up to ${MAX_IMAGES} images.`);
              images = [...images, img];
            } catch (err) {
              if (epoch !== started) return;
              store.error = err instanceof Error ? err.message : String(err);
            }
          }).open(),
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
    if (input?.files) await add([...input.files]);
    if (input) input.value = "";
  }}
/>
<button type="button" class="attach" title="Attach an image of your work" aria-label="Attach image" onclick={open}>
  <Icon name="plus" size={22} stroke={1.7} />{#if images.length}<span class="n">{images.length}</span>{/if}
</button>

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
