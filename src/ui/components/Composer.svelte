<!--
  The entry box of every conversation: text, attached images (pasted, dropped or picked with +)
  and a send button. Enter sends, Shift+Enter adds a line. `form` wraps it in a form of that
  class, submitted by the send button.
-->
<script lang="ts">
  import type { Attachments } from "../lib/attachments.svelte";
  import { imageFiles } from "../lib/images";
  import { enterToSend, SEND_HINT } from "../lib/util";
  import AttachButton from "./AttachButton.svelte";
  import SendButton from "./SendButton.svelte";
  import Thumbs from "./Thumbs.svelte";

  let {
    value = $bindable(""),
    input = $bindable(),
    attachments,
    label,
    placeholder,
    sendLabel,
    onsend,
    busy = false,
    disabled = false,
    compact = false,
    describedby,
    form,
  }: {
    value?: string;
    input?: HTMLTextAreaElement;
    /** Owned by the conversation, so images survive switching between composers. */
    attachments: Attachments;
    label: string;
    placeholder: string;
    sendLabel: string;
    onsend: () => void;
    /** Clawd is answering: sending waits. */
    busy?: boolean;
    disabled?: boolean;
    /** One line to start with, for quick questions. */
    compact?: boolean;
    describedby?: string;
    form?: string;
  } = $props();

  // Images still being prepared hold up sending too.
  const blocked = $derived((!value.trim() && !attachments.images.length) || busy || attachments.preparing > 0);

  function send() {
    onsend();
  }

  function onPaste(e: ClipboardEvent) {
    const files = imageFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void attachments.add(files);
    }
  }

  function onDrop(e: DragEvent) {
    const files = imageFiles(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      void attachments.add(files);
    }
  }
</script>

{#snippet box()}
  {#if attachments.images.length}<div class="imgs">
      <Thumbs images={attachments.images} onremove={(i) => attachments.remove(i)} />
    </div>{/if}
  <textarea
    bind:this={input}
    bind:value
    class:compact
    rows={compact ? 1 : 2}
    {disabled}
    aria-label={label}
    aria-describedby={describedby}
    {placeholder}
    onkeydown={(e) => enterToSend(e, send)}></textarea>
  <div class="ct-composer-actions">
    <AttachButton {attachments} />
    <span class="ct-composer-hint">{SEND_HINT}</span>
    <SendButton
      label={sendLabel}
      type={form ? "submit" : "button"}
      disabled={blocked}
      onclick={form ? undefined : send}
    />
  </div>
{/snippet}

{#if form}
  <form
    class={form}
    onsubmit={(e) => {
      e.preventDefault();
      send();
    }}
    onpaste={onPaste}
    ondrop={onDrop}
    ondragover={(e) => e.preventDefault()}
  >
    <div class="ct-composer">{@render box()}</div>
  </form>
{:else}
  <div class="ct-composer" onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
    {@render box()}
  </div>
{/if}

<style>
  .imgs {
    padding: 10px 10px 0;
  }
</style>
