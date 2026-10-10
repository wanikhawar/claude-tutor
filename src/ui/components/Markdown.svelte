<!--
  Renders Markdown with Obsidian's own renderer, so LaTeX ($…$ and $$…$$) is typeset
  with MathJax, code is highlighted, and it all matches your theme. Nothing in it can load
  from the network (see lib/markdown).
  `inline` renders a short string without a wrapping paragraph.
-->
<script lang="ts">
  import { Component } from "obsidian";
  import { obsidianApp } from "../lib/api";
  import { renderMarkdown } from "../lib/markdown";

  let { md, inline = false }: { md: string; inline?: boolean } = $props();
  let el = $state<HTMLElement>();

  $effect(() => {
    const target = el;
    const text = md ?? "";
    if (!target) return;
    const owner = new Component();
    owner.load();
    target.empty();
    const stop = renderMarkdown(obsidianApp(), text, target, owner, inline);
    return () => {
      stop();
      owner.unload();
    };
  });
</script>

{#if inline}
  <span class="ct-md ct-inline markdown-rendered" bind:this={el}></span>
{:else}
  <div class="ct-md markdown-rendered" bind:this={el}></div>
{/if}
