<script lang="ts">
  // Confirm / prompt dialog driven by app.dialog (remounted for each dialog).
  // It has a message, at most one text input, or a form of several fields.
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import { arrangeDialogButtons } from "../lib/platform";
  import type { DialogButton } from "../lib/store.svelte";

  let value = $state(app.dialog?.input?.value ?? "");
  let input: HTMLInputElement | undefined = $state();
  /** The rendered buttons, by value. */
  const buttons: Record<string, HTMLButtonElement> = $state({});
  const values = $state((app.dialog?.fields ?? []).map((f) => f.value));
  /** Per field: shown in plain text (masked fields start hidden). */
  const shown = $state((app.dialog?.fields ?? []).map((f) => !f.masked));
  const fieldInputs: HTMLInputElement[] = $state([]);

  const d = $derived(app.dialog!);
  const primary = $derived(d.buttons.find((b) => b.role === "primary") ?? d.buttons[d.buttons.length - 1]);
  // Shown in the OS's order, not the order they're listed in.
  const arranged = $derived(arrangeDialogButtons(d.buttons));
  /** What Escape answers: the cancel button's value. */
  const cancelValue = $derived(d.buttons.find((b) => b.role === "cancel")?.value ?? "cancel");

  // Once per dialog: re-selecting on every keystroke would replace what was typed.
  // A confirm (no input) focuses its primary button, so Enter confirms, unless
  // a button asks for focus (Cancel on irreversible confirmations).
  onMount(() => {
    if (fieldInputs[0]) {
      fieldInputs[0].focus();
      return;
    }
    if (!input || !d.input) {
      buttons[(d.buttons.find((b) => b.focus) ?? primary).value]?.focus();
      return;
    }
    input.focus();
    const dot = value.lastIndexOf(".");
    if (d.input.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });

  function enterAnswers(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    // Consumed: focus goes back to the opener at once, and the key must not click it.
    e.preventDefault();
    app.closeDialog(primary.value, value, [...values]);
  }
</script>

{#snippet answer(b: DialogButton)}
  <button class="btn" bind:this={buttons[b.value]} class:primary={b.role === "primary" && !b.danger} class:danger={b.danger} class:solid={b.danger} onclick={() => app.closeDialog(b.value, value, [...values])}>
    {b.label}
  </button>
{/snippet}

<Modal title={d.title} width="420px" onclose={() => app.closeDialog(cancelValue)}>
  <div class="body">
    {#if d.message}<p>{d.message}</p>{/if}
    {#if d.input}
      <input class="input" bind:this={input} bind:value placeholder={d.input.placeholder} onkeydown={enterAnswers} />
    {/if}
    {#each d.fields ?? [] as field, i}
      <div class="field">
        <label class="label" for="dialog-field-{i}">{field.label}</label>
        {#if field.help}<span class="help" id="dialog-help-{i}">{field.help}</span>{/if}
        <span class="with-btn">
          <input
            id="dialog-field-{i}"
            aria-describedby={field.help ? `dialog-help-${i}` : undefined}
            class="input mono"
            type={shown[i] ? "text" : "password"}
            bind:this={fieldInputs[i]}
            bind:value={values[i]}
            spellcheck="false"
            autocomplete="off"
            onkeydown={enterAnswers}
          />
          <button type="button" class="icon-btn" aria-label={shown[i] ? `Hide ${field.label}` : `Show ${field.label}`} use:tooltip onclick={() => (shown[i] = !shown[i])}>
            <Icon name={shown[i] ? "eye-off" : "eye"} />
          </button>
        </span>
      </div>
    {/each}
  </div>
  {#snippet footer()}
    {#each arranged.start as b (b.value)}{@render answer(b)}{/each}
    {#if arranged.start.length}<span class="apart"></span>{/if}
    {#each arranged.end as b (b.value)}{@render answer(b)}{/each}
  {/snippet}
</Modal>

<style>
  .body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  p {
    margin: 0;
    color: var(--text-2);
    line-height: 1.5;
    white-space: pre-line;
    max-height: 50vh;
    overflow: auto;
  }
  .input {
    width: 100%;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
  }
  .help {
    font-size: 12px;
    color: var(--muted);
  }
  /* Sets the far-left buttons (a destructive alternative on macOS and Linux) apart. */
  .apart {
    flex: 1;
  }
  .with-btn {
    display: flex;
    gap: 4px;
    align-items: center;
  }
</style>
