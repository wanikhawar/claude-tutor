<!-- Image previews (removable while composing, clickable to enlarge in the thread). -->
<script lang="ts">
  let { images, onremove, size = 64 }: { images: { id?: number; url: string; name?: string }[]; onremove?: (i: number) => void; size?: number } =
    $props();
  let zoom = $state<string | null>(null);
</script>

{#if images.length}
  <div class="thumbs">
    {#each images as im, i (im.id ?? im.url)}
      <div class="thumb" style="width: {size}px; height: {size}px">
        <button type="button" class="img" title={im.name ?? "image"} onclick={() => (zoom = im.url)}><img src={im.url} alt={im.name ?? "attached image"} /></button>
        {#if onremove}
          <button type="button" class="rm" aria-label="Remove image" title="Remove" onclick={() => onremove(i)}>×</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if zoom}
  <button type="button" class="zoom" aria-label="Close preview" onclick={() => (zoom = null)}><img src={zoom} alt="preview" /></button>
{/if}

<style>
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .thumb {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
    flex: none;
  }
  .img,
  .img img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    cursor: zoom-in;
  }
  .rm {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 13px;
    line-height: 1;
  }
  .zoom {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.75);
    display: grid;
    place-items: center;
    cursor: zoom-out;
    padding: 24px;
  }
  .zoom img {
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
  }
</style>
