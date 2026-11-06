<script lang="ts">
  // The response body's JSONPath filter bar: the expression, how many nodes it
  // matched, a clear button, and an invalid expression's error. The owner runs
  // the filter (in the core) and passes back the outcome. Keys complete from the
  // body's shape summary, which the owner loads when asked (`needshape`).
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { suggestions } from "../lib/popup/suggestions.svelte";
  import { keyCompletion } from "../lib/jsonpath";
  import type { JsonShape } from "../lib/types";

  interface Props {
    value: string;
    onchange: (value: string) => void;
    /** Matches of the current expression, or null while there's none to show. */
    matches: number | null;
    /** Why the expression couldn't run; the full body stays visible. */
    error: string | null;
    /** The body's keys for completion, or null until loaded. */
    shape: JsonShape | null;
    /** Asked on focus and on typing; the owner loads the shape once per response. */
    needshape?: () => void;
  }

  let { value, onchange, matches, error, shape, needshape }: Props = $props();
  const id = $props.id();
</script>

<div class="filter-bar">
  <div class="row">
    <span class="icon" aria-hidden="true"><Icon name="filter" size={13} /></span>
    <input
      class="input mono"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="Filter: $.items[*].id"
      aria-label="Filter with JSONPath"
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      {value}
      use:suggestions={{ label: "Key suggestions", source: shape ? (text, caret) => keyCompletion(text, caret, shape) : () => null }}
      onfocus={() => needshape?.()}
      oninput={(e) => {
        needshape?.();
        onchange(e.currentTarget.value);
      }}
      onkeydown={(e) => {
        if (e.key === "Escape" && value) {
          e.preventDefault();
          onchange("");
        }
      }}
    />
    {#if matches !== null}<span class="count muted" aria-live="polite">{matches} {matches === 1 ? "match" : "matches"}</span>{/if}
    {#if value}
      <button class="icon-btn" aria-label="Clear filter" use:tooltip={"Clear filter (Esc)"} onclick={() => onchange("")}><Icon name="x" size={13} /></button>
    {/if}
  </div>
  {#if error}<div class="error selectable" id="{id}-error" role="alert">{error}</div>{/if}
</div>

<style>
  .filter-bar {
    flex: 1 1 240px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .icon {
    position: absolute;
    left: 8px;
    display: flex;
    color: var(--faint);
    pointer-events: none;
  }
  .input {
    flex: 1;
    height: var(--control-h-sm);
    padding-left: 26px;
  }
  .input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .count {
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .error {
    color: var(--danger);
    font-size: 11.5px;
    word-break: break-word;
  }
</style>
