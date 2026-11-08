<script lang="ts">
  // A "…" menu button for a thing's own actions (a row, a column header): the Menu
  // button of controls.md. It's hidden until the pointer is over, or focus is in,
  // the nearest element marked `data-actions-host`, and while its menu is open.
  import { menu, type MenuItem } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    /** Accessible name, e.g. "Actions for baseUrl"; also the menu's. */
    label: string;
    /** The menu's items, read when it opens. */
    items: () => MenuItem[];
    tip?: string;
    /** Out of the Tab order, when the thing's own field already opens the same items (Shift+F10). */
    skipTab?: boolean;
  }
  let { label, items, tip = "Actions", skipTab = false }: Props = $props();

  let button = $state<HTMLButtonElement>();

  function toggle(e: MouseEvent) {
    if (menu.isOpenFrom(button)) return menu.close(false);
    menu.show(e, items(), { anchor: button, align: "end", label });
  }
</script>

<button
  bind:this={button}
  class="icon-btn actions-btn"
  tabindex={skipTab ? -1 : undefined}
  aria-label={label}
  aria-haspopup="menu"
  aria-expanded={menu.isOpenFrom(button)}
  use:tooltip={tip}
  onclick={toggle}
>
  <Icon name="more" size={13} />
</button>

<style>
  .actions-btn {
    flex: none;
    margin-right: var(--space-1);
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    opacity: 0;
  }
  :global([data-actions-host]:hover) .actions-btn,
  :global([data-actions-host]:focus-within) .actions-btn,
  .actions-btn[aria-expanded="true"] {
    opacity: 1;
  }
</style>
