<script lang="ts">
  // On/off switch for request components.
  import { tooltip } from "../lib/popup/tooltip.svelte";

  interface Props {
    checked: boolean;
    onchange: (v: boolean) => void;
    /** Tooltip text; defaults to what a click does. */
    title?: string;
    /** Visible text next to the switch. */
    label?: string;
    /** Accessible name when there's no `label` (the setting it controls). */
    ariaLabel?: string;
  }
  let { checked, onchange, title = "", label = "", ariaLabel }: Props = $props();
</script>

<button
  type="button"
  class="toggle"
  class:on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  use:tooltip={title || (checked ? "Enabled — click to disable" : "Disabled — click to enable")}
  onclick={(e) => {
    e.stopPropagation();
    onchange(!checked);
  }}
>
  <span class="track"><span class="knob"></span></span>
  {#if label}<span class="label">{label}</span>{/if}
</button>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
  }
  .track {
    width: 28px;
    height: 16px;
    border-radius: 8px;
    background: var(--panel-3);
    border: 1px solid var(--border-strong);
    position: relative;
    transition: background 0.15s;
    flex: none;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
    transition: transform 0.15s, background 0.15s;
  }
  .toggle:focus-visible {
    outline: none;
  }
  .toggle:focus-visible .track {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .on .track {
    background: var(--accent);
    border-color: var(--accent);
  }
  .on .knob {
    transform: translateX(12px);
    background: var(--on-accent);
  }
  .on .label {
    color: var(--text-2);
  }
</style>
