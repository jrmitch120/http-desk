<script lang="ts" generics="T extends string">
  // Pick one of a few options (ADR 0002). An ARIA radiogroup with roving focus:
  // Tab reaches the checked option, arrow keys (and Home/End) move and select.
  import Icon from "./Icon.svelte";

  interface Option {
    value: T;
    label: string;
    icon?: string;
  }
  interface Props {
    options: Option[];
    value: T;
    onchange: (value: T) => void;
    /** Accessible name of the group. */
    label: string;
  }

  let { options, value, onchange, label }: Props = $props();

  const buttons: HTMLButtonElement[] = $state([]);
  // The one option reachable by Tab: the checked one, or the first if none is.
  const tabStop = $derived(Math.max(0, options.findIndex((o) => o.value === value)));

  const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

  function onkeydown(e: KeyboardEvent) {
    const n = options.length;
    if (!n) return;
    const from = options.findIndex((o) => o.value === value);
    let to: number;
    if (e.key in STEP) to = (((from < 0 ? 0 : from) + STEP[e.key]) % n + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else return;
    e.preventDefault();
    buttons[to]?.focus();
    if (options[to].value !== value) onchange(options[to].value);
  }
</script>

<div class="segmented" role="radiogroup" aria-label={label} tabindex="-1" {onkeydown}>
  {#each options as o, i (o.value)}
    <button
      type="button"
      role="radio"
      aria-checked={o.value === value}
      tabindex={i === tabStop ? 0 : -1}
      bind:this={buttons[i]}
      onclick={() => o.value !== value && onchange(o.value)}
    >
      {#if o.icon}<Icon name={o.icon} size={13} />{/if}{o.label}
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    flex-wrap: wrap;
    align-self: flex-start;
    max-width: 100%;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius);
    background: var(--panel-3);
    border: 1px solid var(--border);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-h-sm);
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover {
    color: var(--text);
  }
  button[aria-checked="true"] {
    background: var(--panel);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
