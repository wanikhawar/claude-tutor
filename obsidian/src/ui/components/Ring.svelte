<!-- Circular progress: mastery dots in lists, score rings in feedback. -->
<script lang="ts">
  let {
    value,
    size = 16,
    width = 2.5,
    color = "var(--accent)",
    label = "",
    empty = false,
  }: { value: number; size?: number; width?: number; color?: string; label?: string; empty?: boolean } = $props();

  const r = $derived((size - width) / 2);
  const c = $derived(2 * Math.PI * r);
</script>

<svg width={size} height={size} viewBox="0 0 {size} {size}" class="ring">
  <circle cx={size / 2} cy={size / 2} {r} fill="none" stroke="var(--surface-3)" stroke-width={width} />
  {#if !empty}
    <circle
      cx={size / 2}
      cy={size / 2}
      {r}
      fill="none"
      stroke={color}
      stroke-width={width}
      stroke-linecap="round"
      stroke-dasharray="{Math.max(0.001, Math.min(1, value)) * c} {c}"
      transform="rotate(-90 {size / 2} {size / 2})"
    />
  {/if}
  {#if label}
    <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-size={size * 0.3}>{label}</text>
  {/if}
</svg>

<style>
  .ring {
    flex: none;
  }
  text {
    fill: var(--text);
    font-weight: 650;
    font-family: var(--font-ui);
  }
  circle {
    transition: stroke-dasharray 0.6s ease;
  }
</style>
