<script lang="ts">
  // A number typed into a text field (ADR 0002): a unit inside the box's end (an
  // `.input.boxed` with an `.input-end`, docs/controls.md) and no spinners. It refuses any
  // keystroke or paste that would leave something a number of its kind can't become
  // (digits, one decimal point unless `integer`, a leading minus only when `min` allows
  // one): the field keeps its text and caret as they were, rather than keeping part of
  // what arrived. It applies on blur or Enter, never per keystroke. A value it still can't
  // apply (empty, or below `min`) puts back the last value, with no error message: there
  // is nothing to show and nothing to move.
  import { textFieldAttrs } from "../lib/textField";

  interface Props {
    value: number;
    onchange: (value: number) => void;
    /** Accessible name of the field. */
    label: string;
    /** Shown inside the field, after the number, e.g. "s" or "MB". */
    unit?: string;
    min?: number;
    /** Only whole numbers: the field takes no decimal point. */
    integer?: boolean;
    disabled?: boolean;
  }

  let { value, onchange, label, unit = "", min, integer = false, disabled = false }: Props = $props();

  const id = $props.id();
  // What the user has typed since the field last applied; null shows `value`.
  let draft = $state<string | null>(null);

  /** Whether `text` is on the way to a number this field can hold ("", "-" and "1." are). */
  const partial = $derived(
    new RegExp(`^${min === undefined || min < 0 ? "-?" : ""}\\d*${integer ? "" : "(\\.\\d*)?"}$`),
  );

  /** The number `text` holds, or null when it can't be applied (empty, or below `min`). */
  function parse(text: string): number | null {
    const n = Number(text);
    if (text === "" || text === "-" || text === "." || text === "-." || !Number.isFinite(n)) return null;
    if (min !== undefined && n < min) return null;
    return n;
  }

  /** Applies the draft, or puts back the last value when it can't be applied. */
  function commit() {
    if (draft === null) return;
    const n = parse(draft);
    draft = null;
    if (n !== null && n !== value) onchange(n);
  }

  function oninput(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const before = draft ?? String(value);
    if (partial.test(el.value)) {
      draft = el.value;
      return;
    }
    // Refused: put back the text, and select what the edit replaced (the caret where it
    // was, for a plain keystroke or paste). The edit replaced before[start, end) with
    // after[start, caret): what's before the caret and after it is unchanged.
    const after = el.value;
    const caret = el.selectionStart ?? after.length;
    let tail = 0;
    while (tail < before.length && tail < after.length - caret && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
    let start = 0;
    while (start < before.length - tail && start < caret && before[start] === after[start]) start++;
    el.value = before;
    el.setSelectionRange(start, before.length - tail);
  }
</script>

<div class="number-field input boxed">
  <input
    {...textFieldAttrs}
    id="{id}-input"
    type="text"
    inputmode={integer ? "numeric" : "decimal"}
    aria-label={label}
    {disabled}
    value={draft ?? String(value)}
    {oninput}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    }}
  />
  {#if unit}
    <!-- A label, so pressing on the unit focuses the field; the field's name stays `label`. -->
    <label class="unit input-end" for="{id}-input">{unit}</label>
  {/if}
</div>

<style>
  /* One width for every NumberField, whatever its unit, so fields line up down a page. */
  .number-field {
    width: 96px;
  }
  input {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .unit {
    cursor: text;
    user-select: none;
  }
</style>
