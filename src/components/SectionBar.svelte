<script lang="ts">
  // Header row for a request component with its enable/disable switch.
  import type { Snippet } from "svelte";
  import Toggle from "./Toggle.svelte";

  interface Props {
    title: string;
    enabled: boolean;
    onchange: (v: boolean) => void;
    showToggle?: boolean;
    children?: Snippet;
  }
  let { title, enabled, onchange, showToggle = true, children }: Props = $props();
</script>

<div class="section-bar">
  <span class="title">{title}</span>
  {#if showToggle}
    <Toggle checked={enabled} {onchange} label={enabled ? "Enabled" : "Disabled"} />
  {/if}
  <span class="spacer"></span>
  {#if children}{@render children()}{/if}
</div>
{#if showToggle && !enabled}
  <div class="off-note">
    <strong>{title} disabled.</strong> Nothing here is sent; your configuration is kept in the file as comments and can be re-enabled anytime.
  </div>
{/if}

<style>
  .section-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 28px;
    margin-bottom: 8px;
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .off-note {
    font-size: 12px;
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    margin-bottom: 10px;
    line-height: 1.5;
  }
</style>
