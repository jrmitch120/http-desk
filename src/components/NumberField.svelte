<script lang="ts">
  // A number typed into a text field (ADR 0002): a unit suffix, inline validation
  // and no spinners. It applies on blur or Enter, never per keystroke. A value
  // that isn't valid shows an error and is never applied; leaving the field puts
  // back the last valid value.
  interface Props {
    value: number;
    onchange: (value: number) => void;
    /** Accessible name of the field. */
    label: string;
    /** Shown after the field, e.g. "s" or "MB". */
    unit?: string;
    min?: number;
    max?: number;
    /** Only whole numbers are valid. */
    integer?: boolean;
    disabled?: boolean;
  }

  let { value, onchange, label, unit = "", min, max, integer = false, disabled = false }: Props = $props();

  const id = $props.id();
  // What the user has typed since the field last applied; null shows `value`.
  let draft = $state<string | null>(null);

  function check(text: string): { n: number; error: "" } | { n: null; error: string } {
    const t = text.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n)) return { n: null, error: "Enter a number" };
    if (integer && !Number.isInteger(n)) return { n: null, error: "Enter a whole number" };
    if (min !== undefined && n < min) return { n: null, error: `Must be at least ${min}` };
    if (max !== undefined && n > max) return { n: null, error: `Must be at most ${max}` };
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
  <div class="row">
    <input
      class="input"
      type="text"
      inputmode={integer ? "numeric" : "decimal"}
      autocomplete="off"
      spellcheck="false"
      aria-label={label}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      {disabled}
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
    {#if unit}<span class="unit" class:disabled>{unit}</span>{/if}
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
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .input {
    width: 84px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .unit {
    min-width: 2ch;
    color: var(--muted);
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
