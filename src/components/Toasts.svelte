<script lang="ts">
  import { app } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="toasts">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}" role="status">
      <Icon name={t.kind === "error" ? "alert" : "check"} />
      <span class="selectable">{t.message}</span>
      <button class="icon-btn" onclick={() => (app.toasts = app.toasts.filter((x) => x.id !== t.id))}><Icon name="x" size={13} /></button>
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
