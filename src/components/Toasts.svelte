<script lang="ts">
  import { app } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  // A toast stays while hovered or while text in it is selected.
  const hovered = new Set<string>();
  const selected = new Set<string>();
  const sync = (id: string) => app.holdToast(id, hovered.has(id) || selected.has(id));

  function hover(id: string, on: boolean) {
    if (on) hovered.add(id);
    else hovered.delete(id);
    sync(id);
  }

  function onSelectionChange() {
    const sel = document.getSelection();
    for (const el of document.querySelectorAll<HTMLElement>(".toast[data-id]")) {
      const id = el.dataset.id!;
      const inside = !!sel && !sel.isCollapsed && (el.contains(sel.anchorNode) || el.contains(sel.focusNode));
      if (inside === selected.has(id)) continue;
      if (inside) selected.add(id);
      else selected.delete(id);
      sync(id);
    }
  }
</script>

<svelte:document onselectionchange={onSelectionChange} />

<div class="toasts">
  {#each app.toasts as t (t.id)}
    <div
      class="toast {t.kind}"
      data-id={t.id}
      role={t.kind === "error" ? "alert" : "status"}
      onmouseenter={() => hover(t.id, true)}
      onmouseleave={() => hover(t.id, false)}
    >
      <Icon name={t.kind === "error" ? "alert" : "check"} />
      <span class="selectable">{t.message}</span>
      <button class="icon-btn" aria-label="Dismiss" use:tooltip onclick={() => (app.toasts = app.toasts.filter((x) => x.id !== t.id))}>
        <Icon name="x" size={13} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 36px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 200;
    max-width: 440px;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 10px 8px 10px 12px;
    border-radius: 8px;
    background: var(--panel-2);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
    line-height: 1.45;
    animation: slide 0.16s ease-out;
    word-break: break-word;
  }
  .toast span {
    flex: 1;
    padding-top: 1px;
  }
  .toast.error { border-left: 3px solid var(--danger); }
  .toast.error :global(svg) { color: var(--danger); flex: none; margin-top: 2px; }
  .toast.success { border-left: 3px solid var(--success); }
  .toast.success :global(svg), .toast.info :global(svg) { color: var(--success); flex: none; margin-top: 2px; }
  .toast.info { border-left: 3px solid var(--info); }
  @keyframes slide {
    from { transform: translateY(8px); opacity: 0; }
  }
</style>
