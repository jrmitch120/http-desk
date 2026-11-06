<script lang="ts">
  // The response body's JSONPath filter bar: the expression, how many nodes it
  // matched, a clear button, and an invalid expression's error. The owner runs
  // the filter (in the core) and passes back the outcome. Keys complete from the
  // body's shape summary, which the owner loads when asked (`needshape`).
  import Icon from "./Icon.svelte";
  import FilterField from "./FilterField.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
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
    <FilterField
      {value}
      label="Filter with JSONPath"
      placeholder="Filter: $.items[*].id"
      mono
      invalid={!!error}
      describedby={error ? `${id}-error` : undefined}
      suggest={{ label: "Key suggestions", source: shape ? (text, caret) => keyCompletion(text, caret, shape) : () => null }}
      onfocus={() => needshape?.()}
      oninput={(v) => {
        needshape?.();
        onchange(v);
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
    display: flex;
    align-items: center;
    gap: var(--space-2);
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
