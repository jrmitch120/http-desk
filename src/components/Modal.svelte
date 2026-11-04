<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    title: string;
    onclose: () => void;
    width?: string;
    height?: string;
    children: Snippet;
    footer?: Snippet;
  }
  let { title, onclose, width = "560px", height, children, footer }: Props = $props();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onmousedown={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" style:width style:height role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <h2>{title}</h2>
      <button class="icon-btn" onclick={onclose} title="Close"><Icon name="x" /></button>
    </header>
    <div class="content">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    animation: fade 0.12s ease-out;
  }
  .modal {
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 48px);
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: pop 0.14s ease-out;
  }
  header {
    display: flex;
    align-items: center;
    padding: 12px 14px 12px 18px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    flex: 1;
  }
  .content {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    flex: none;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  @keyframes pop {
    from { transform: scale(0.97); opacity: 0; }
  }
</style>
