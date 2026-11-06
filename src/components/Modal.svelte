<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  interface Props {
    title: string;
    onclose: () => void;
    width?: string;
    height?: string;
    children: Snippet;
    footer?: Snippet;
  }
  let { title, onclose, width = "560px", height, children, footer }: Props = $props();

  let box: HTMLDivElement | undefined = $state();

  // Focus goes back to where it was when the modal opened.
  const returnTo = document.activeElement;
  onDestroy(() => {
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
  });

  /**
   * Blurs a focused field inside the modal before closing, so a field that
   * applies on blur (NumberField, Settings paths) keeps what was typed. WebKit
   * fires no blur when the focused element is removed with the modal.
   */
  function close() {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && box?.contains(focused)) focused.blur();
    onclose();
  }

  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]';

  /** Keeps Tab / Shift+Tab cycling inside the topmost modal. */
  function trapTab(e: KeyboardEvent) {
    if (e.key !== "Tab" || e.defaultPrevented || !box) return;
    const modals = document.querySelectorAll('[aria-modal="true"]');
    if (modals[modals.length - 1] !== box) return;
    // Tab stops only: roving widgets (SegmentedControl, grids) hold tabindex=-1 buttons.
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = box.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") close();
    else trapTab(e);
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onmousedown={(e) => e.target === e.currentTarget && close()}>
  <div class="modal" bind:this={box} style:width style:height role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <h2>{title}</h2>
      <button class="icon-btn" onclick={close} aria-label="Close" use:tooltip><Icon name="x" /></button>
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
