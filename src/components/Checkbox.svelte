<script lang="ts">
  // Owned checkbox (ADR 0002): a button with role="checkbox", so it looks the
  // same in every OS webview. `indeterminate` shows the mixed state (e.g. an
  // "enable all" box when only some rows are on); clicking a mixed box checks
  // it, like a native checkbox. Space toggles; Enter does nothing, as natively.
  // Pass `label` for an icon-only box, or children for a visible label that is
  // part of the click target.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import { tooltip as tip } from "../lib/popup/tooltip.svelte";

  interface Props {
    checked: boolean;
    /** Mixed state; wins over `checked` for display. */
    indeterminate?: boolean;
    onchange: (checked: boolean) => void;
    /** Accessible name when there are no children. */
    label?: string;
    /** Tooltip text (use:tooltip). */
    tooltip?: string;
    /** Extra class on the root, for laying out a labelled row. */
    class?: string;
    children?: Snippet;
  }
  let { checked, indeterminate = false, onchange, label, tooltip, class: className = "", children }: Props = $props();
</script>

<button
  type="button"
  role="checkbox"
  class="checkbox {className}"
  class:on={checked || indeterminate}
  aria-checked={indeterminate ? "mixed" : checked}
  aria-label={label}
  use:tip={tooltip ?? null}
  onclick={() => onchange(indeterminate ? true : !checked)}
  onkeydown={(e) => {
    if (e.key === "Enter") e.preventDefault();
  }}
>
  <span class="box">
    {#if indeterminate}<Icon name="minus" size={12} stroke={2.6} />{:else if checked}<Icon name="check" size={12} stroke={2.6} />{/if}
  </span>
  {#if children}{@render children()}{/if}
</button>

<style>
  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  .box {
    flex: none;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    background: var(--panel);
    color: var(--on-accent);
    transition: background 0.1s, border-color 0.1s;
  }
  .checkbox:hover .box {
    border-color: var(--muted);
  }
  .on .box,
  .checkbox.on:hover .box {
    background: var(--accent);
    border-color: var(--accent);
  }
  .checkbox:focus-visible .box {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
