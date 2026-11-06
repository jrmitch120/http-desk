<script lang="ts">
  // The one tooltip element (see lib/popup/tooltip.svelte.ts). Mounted once in App.
  import { onMount } from "svelte";
  import { portal } from "../lib/popup/layer";
  import { placeElement } from "../lib/popup/place";
  import { hideTooltip, tip, TOOLTIP_ID } from "../lib/popup/tooltip.svelte";

  let el: HTMLDivElement | undefined = $state();

  $effect(() => {
    const anchor = tip.anchor;
    void tip.text;
    if (!tip.visible || !anchor || !el) return;
    if (!anchor.isConnected) return hideTooltip();
    placeElement(el, anchor.getBoundingClientRect(), { align: "center", gap: 6 });
  });

  // Any key (Escape included, which still reaches modals and menus), a scroll or
  // leaving the window hides it, like a native tooltip.
  onMount(() => {
    const opts = { capture: true, passive: true };
    const onKey = () => hideTooltip(false);
    const hide = () => hideTooltip();
    window.addEventListener("keydown", onKey, opts);
    window.addEventListener("scroll", hide, opts);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("scroll", hide, opts);
      window.removeEventListener("blur", hide);
    };
  });
</script>

<div bind:this={el} use:portal id={TOOLTIP_ID} class="popup-surface tooltip" role="tooltip" hidden={!tip.visible}>{tip.text}</div>

<style>
  .tooltip {
    max-width: 360px;
    padding: 4px 8px;
    font-size: 12px;
    line-height: 1.4;
    overflow-wrap: anywhere;
    pointer-events: none;
  }
  .tooltip[hidden] {
    display: none;
  }
</style>
