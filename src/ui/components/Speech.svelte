<!-- Clawd's speech bubble with a typewriter reveal. -->
<script lang="ts">
  let { text, tail = "left" }: { text: string; tail?: "left" | "bottom" } = $props();
  let shown = $state(0);

  $effect(() => {
    const full = text;
    shown = 0;
    const t = setInterval(() => {
      shown += 2;
      if (shown >= full.length) clearInterval(t);
    }, 18);
    return () => clearInterval(t);
  });
</script>

<div class="bubble tail-{tail}" aria-live="polite">
  <span class="ghost">{text}</span>
  <span class="live">{text.slice(0, shown)}</span>
</div>

<style>
  .bubble {
    position: relative;
    background: var(--surface);
    border: 1.5px solid var(--accent);
    border-radius: 16px;
    padding: 12px 16px;
    font-size: 1rem;
    line-height: 1.45;
    display: grid;
    box-shadow: var(--shadow);
  }
  /* Reserve the final size so the bubble doesn't grow while typing. */
  .ghost,
  .live {
    grid-area: 1 / 1;
  }
  .ghost {
    visibility: hidden;
  }
  .bubble::before {
    content: "";
    position: absolute;
    width: 12px;
    height: 12px;
    background: var(--surface);
    border: 1.5px solid var(--accent);
    border-top: 0;
    border-right: 0;
  }
  .tail-left::before {
    left: -7.5px;
    top: 50%;
    transform: translateY(-50%) rotate(45deg);
  }
  .tail-bottom::before {
    bottom: -7.5px;
    left: 50%;
    transform: translateX(-50%) rotate(-45deg);
  }
</style>
