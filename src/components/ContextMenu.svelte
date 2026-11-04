<script lang="ts">
  import { menu } from "../lib/menu.svelte";
  import Icon from "./Icon.svelte";

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });

  $effect(() => {
    const m = menu.open;
    if (!m || !el) return;
    const r = el.getBoundingClientRect();
    pos = { x: Math.min(m.x, window.innerWidth - r.width - 6), y: Math.min(m.y, window.innerHeight - r.height - 6) };
  });
</script>

<svelte:window onmousedown={(e) => el && !el.contains(e.target as Node) && menu.close()} onkeydown={(e) => e.key === "Escape" && menu.close()} onblur={() => menu.close()} />

{#if menu.open}
  <div class="menu" bind:this={el} style:left="{pos.x}px" style:top="{pos.y}px" role="menu">
    {#each menu.open.items as item, i (i)}
      {#if item.separator}
        <div class="sep"></div>
      {:else}
        <button
          class="item"
          class:danger={item.danger}
          disabled={item.disabled}
          role="menuitem"
          onclick={() => {
            menu.close();
            item.action?.();
          }}
        >
          <span class="ico">{#if item.icon}<Icon name={item.icon} size={14} />{/if}</span>
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 300;
    min-width: 190px;
    padding: 4px;
    background: var(--panel-2);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: var(--shadow);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px 6px 6px;
    border: none;
    background: none;
    border-radius: 5px;
    text-align: left;
    cursor: pointer;
    color: var(--text);
  }
  .item:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .item:disabled {
    opacity: 0.45;
  }
  .item.danger {
    color: var(--danger);
  }
  .ico {
    width: 16px;
    display: inline-flex;
    color: var(--muted);
  }
  .danger .ico {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 4px 2px;
  }
</style>
