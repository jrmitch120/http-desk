<script lang="ts">
  // Header row for a request component with its enable/disable switch.
  import type { Snippet } from "svelte";
  import Banner from "./Banner.svelte";
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
  <Banner severity="warning" inline class="off-note">
    <strong>{title} disabled.</strong> Nothing here is sent; your configuration is kept in the file as comments and can be re-enabled anytime.
  </Banner>
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
  :global(.off-note) {
    margin-bottom: 10px;
  }
</style>
