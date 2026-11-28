<script lang="ts">
  import { textFieldAttrs } from "../lib/textField";
  // A number typed into a text field (ADR 0002): a unit suffix inside the box and no
  // spinners. It takes only what a number of its kind can hold (digits, one decimal
  // point unless `integer`, a leading minus only when `min` allows one); anything else
  // typed or pasted is dropped as it arrives. It applies on blur or Enter, never per
  // keystroke. A value it still can't apply (empty, or below `min`) puts back the last
  // value, with no error message: there is nothing to show and nothing to move.
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
  // The unit is drawn over the input's right padding; the number stops short of it.
  let unitWidth = $state(0);

  /** `text` with everything this field can't hold removed, and where `caret` ends up. */
  function clean(text: string, caret: number): { text: string; caret: number } {
    const negative = min === undefined || min < 0;
    let out = "";
    let at = caret;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const keep =
        (c >= "0" && c <= "9") ||
        (c === "." && !integer && !out.includes(".")) ||
        (c === "-" && negative && out === "");
      if (keep) out += c;
      else if (i < caret) at--;
    }
    return { text: out, caret: at };
  }

  /** The number `text` holds, or null when it can't be applied (empty, or below `min`). */
  function parse(text: string): number | null {
    const n = Number(text);
    if (text === "" || text === "-" || text === "." || !Number.isFinite(n)) return null;
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
    const { text, caret } = clean(el.value, el.selectionStart ?? el.value.length);
    if (text !== el.value) {
      el.value = text;
      el.setSelectionRange(caret, caret);
    }
    draft = text;
  }
</script>

<div class="number-field">
  <input
    {...textFieldAttrs}
    id="{id}-input"
    class="input"
    type="text"
    inputmode={integer ? "numeric" : "decimal"}
    aria-label={label}
    {disabled}
    style:padding-right={unit ? `${unitWidth + 13}px` : undefined}
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
    <label class="unit" class:disabled for="{id}-input" bind:offsetWidth={unitWidth}>{unit}</label>
  {/if}
</div>

<style>
  /* One width for every NumberField, whatever its unit, so fields line up down a page. */
  .number-field {
    position: relative;
    width: 96px;
  }
  .input {
    width: 100%;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .unit {
    position: absolute;
    top: 50%;
    right: 9px;
    transform: translateY(-50%);
    color: var(--muted);
    cursor: text;
    user-select: none;
  }
  .unit.disabled {
    opacity: 0.5;
  }
</style>
