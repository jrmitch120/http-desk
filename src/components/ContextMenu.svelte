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

  // Opens focused on its first item, so the keyboard can drive it.
  $effect(() => {
    if (menu.open && el) items()[0]?.focus();
  });

  const items = () => [...(el?.querySelectorAll<HTMLButtonElement>(".item:not(:disabled)") ?? [])];

  /** Up/Down (wrapping), Home/End move between enabled items; Enter/Space click the focused one. */
  function onKey(e: KeyboardEvent) {
    const all = items();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = (at + 1) % all.length;
    else if (e.key === "ArrowUp") next = (at - 1 + all.length) % all.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      menu.close();
      return;
    } else return;
    e.preventDefault();
    all[next].focus();
  }
</script>

<svelte:window
  onmousedown={(e) => el && !el.contains(e.target as Node) && menu.close(false)}
  onkeydown={(e) => menu.open && e.key === "Escape" && menu.close()}
  onblur={() => menu.close(false)}
/>

{#if menu.open}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="menu" bind:this={el} style:left="{pos.x}px" style:top="{pos.y}px" role="menu" onkeydown={onKey}>
    {#each menu.open.items as item, i (i)}
      {#if item.separator}
        <div class="sep" role="separator"></div>
      {:else}
        <button
          class="item"
          class:danger={item.danger}
          disabled={item.disabled}
          role="menuitem"
          tabindex="-1"
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
    outline: none;
  }
  .item:hover:not(:disabled),
  .item:focus-visible {
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
