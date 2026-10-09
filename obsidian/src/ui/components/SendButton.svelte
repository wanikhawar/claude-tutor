<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    label,
    disabled = false,
    type = "button",
    onclick,
  }: {
    label: string;
    disabled?: boolean;
    type?: "button" | "submit";
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button class="ct-send" {type} {disabled} {onclick} aria-label={label} title={`${label} · Enter`}>
  <Icon name="up" size={20} />
  <span class="ct-sr-only">{label}</span>
</button>
