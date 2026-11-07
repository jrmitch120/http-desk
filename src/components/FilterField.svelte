<script lang="ts">
  // A filter box: a text field with a filter icon inside it, for narrowing what
  // a panel shows (header names, a JSONPath over the body), or with a search
  // icon for the editor's find bar. It fills the space
  // its owner gives it. The owner keeps the value and decides what typing does;
  // `suggest` turns it into a combobox (see use:suggestions).
  import Icon from "./Icon.svelte";
  import { suggestions, type SuggestionsOptions } from "../lib/popup/suggestions.svelte";

  interface Props {
    value: string;
    oninput: (value: string) => void;
    /** The accessible name. */
    label: string;
    placeholder?: string;
    /** The icon inside the field: `filter` (default), or `search` for finding text. */
    icon?: "filter" | "search";
    /** Monospace text, for expressions. */
    mono?: boolean;
    /** Marks the value invalid (a danger border); pair it with `describedby`. */
    invalid?: boolean;
    /** The id of the element explaining an invalid value. */
    describedby?: string;
    suggest?: SuggestionsOptions;
    onfocus?: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
  }

  let { value, oninput, label, placeholder, icon = "filter", mono = false, invalid = false, describedby, suggest, onfocus, onkeydown }: Props = $props();

  /** Without `suggest`, the field stays a plain textbox. */
  const NO_SUGGESTIONS: SuggestionsOptions = { options: [], label: "" };
</script>

<div class="filter-field">
  <span class="icon" aria-hidden="true"><Icon name={icon} size={13} /></span>
  <input
    class="input small"
    class:mono
    type="text"
    spellcheck="false"
    autocomplete="off"
    {placeholder}
    aria-label={label}
    aria-invalid={invalid ? "true" : undefined}
    aria-describedby={describedby}
    {value}
    use:suggestions={suggest ?? NO_SUGGESTIONS}
    onfocus={() => onfocus?.()}
    oninput={(e) => oninput(e.currentTarget.value)}
    onkeydown={(e) => onkeydown?.(e)}
  />
</div>

<style>
  .filter-field {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .icon {
    position: absolute;
    left: var(--space-2);
    display: flex;
    color: var(--faint);
    pointer-events: none;
  }
  .input {
    flex: 1;
    padding-left: var(--space-6);
  }
  .input[aria-invalid="true"] {
    border-color: var(--danger);
  }
</style>
