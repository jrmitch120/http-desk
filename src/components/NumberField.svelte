<script lang="ts">
  // A number typed into a text field (ADR 0002): a unit suffix inside the box, inline validation
  // and no spinners. It applies on blur or Enter, never per keystroke. A value
  // that isn't valid shows an error and is never applied; leaving the field puts
  // back the last valid value.
  interface Props {
    value: number;
    onchange: (value: number) => void;
    /** Accessible name of the field. */
    label: string;
    /** Shown inside the field, after the number, e.g. "s" or "MB". */
    unit?: string;
    min?: number;
    /** Only whole numbers are valid. */
    integer?: boolean;
    disabled?: boolean;
  }

  let { value, onchange, label, unit = "", min, integer = false, disabled = false }: Props = $props();

  const id = $props.id();
  // What the user has typed since the field last applied; null shows `value`.
  let draft = $state<string | null>(null);
  // The unit is drawn over the input's right padding; the number stops short of it.
  let unitWidth = $state(0);

  function check(text: string): { n: number; error: "" } | { n: null; error: string } {
    const t = text.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n)) return { n: null, error: "Enter a number" };
    if (integer && !Number.isInteger(n)) return { n: null, error: "Enter a whole number" };
    if (min !== undefined && n < min) return { n: null, error: `Must be at least ${min}` };
    return { n, error: "" };
  }

  const error = $derived(draft === null ? "" : check(draft).error);

  /** Applies a valid draft. An invalid one stays put (Enter) or is dropped (blur). */
  function commit(onInvalid: "keep" | "revert") {
    if (draft === null) return;
    const { n } = check(draft);
    if (n === null) {
      if (onInvalid === "revert") draft = null;
      return;
    }
    draft = null;
    if (n !== value) onchange(n);
  }
</script>

<div class="number-field">
  <div class="box">
    <input
      id="{id}-input"
      class="input"
      type="text"
      inputmode={integer ? "numeric" : "decimal"}
      autocomplete="off"
      spellcheck="false"
      aria-label={label}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      {disabled}
      style:padding-right={unit ? `${unitWidth + 13}px` : undefined}
      value={draft ?? String(value)}
      oninput={(e) => (draft = e.currentTarget.value)}
      onblur={() => commit("revert")}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit("keep");
        }
      }}
    />
    {#if unit}
      <!-- A label, so pressing on the unit focuses the field; the field's name stays `label`. -->
      <label class="unit" class:disabled for="{id}-input" bind:offsetWidth={unitWidth}>{unit}</label>
    {/if}
  </div>
  {#if error}<div class="error" id="{id}-error" role="alert">{error}</div>{/if}
</div>

<style>
  .number-field {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-1);
  }
  /* One width for every NumberField, whatever its unit, so fields line up down a page. */
  .box {
    position: relative;
    width: 96px;
  }
  .input {
    width: 100%;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .input[aria-invalid="true"] {
    border-color: var(--danger);
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
  .error {
    color: var(--danger);
    font-size: 11.5px;
    white-space: nowrap;
  }
</style>
