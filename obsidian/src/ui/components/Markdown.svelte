<!--
  Renders Markdown with Obsidian's own renderer, so LaTeX ($…$ and $$…$$) is typeset
  with MathJax, code is highlighted, and it all matches your theme.
  `inline` renders a short string without a wrapping paragraph.
-->
<script lang="ts">
  import { Component, MarkdownRenderer } from "obsidian";
  import { obsidianApp } from "../lib/api";

  let { md, inline = false }: { md: string; inline?: boolean } = $props();
  let el = $state<HTMLElement>();

  $effect(() => {
    const target = el;
    const text = md ?? "";
    if (!target) return;
    const owner = new Component();
    owner.load();
    target.empty();
    void MarkdownRenderer.render(obsidianApp(), text, target, "", owner).then(() => {
      const only = target.firstElementChild;
      if (inline && target.childElementCount === 1 && only?.tagName === "P") {
        target.append(...Array.from(only.childNodes));
        only.remove();
      }
    });
    return () => owner.unload();
  });
</script>

{#if inline}
  <span class="ct-md ct-inline markdown-rendered" bind:this={el}></span>
{:else}
  <div class="ct-md markdown-rendered" bind:this={el}></div>
{/if}
