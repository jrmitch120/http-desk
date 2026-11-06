<script lang="ts">
  // Confirm / prompt dialog driven by app.dialog (remounted for each dialog).
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import Modal from "./Modal.svelte";

  let value = $state(app.dialog?.input?.value ?? "");
  let input: HTMLInputElement | undefined = $state();
  const buttons: HTMLButtonElement[] = $state([]);

  const d = $derived(app.dialog!);
  const primary = $derived(d.buttons.find((b) => b.primary) ?? d.buttons[d.buttons.length - 1]);

  // Once per dialog: re-selecting on every keystroke would replace what was typed.
  // A confirm (no input) focuses its primary button, so Enter confirms, unless
  // a button asks for focus (Cancel on irreversible confirmations).
  onMount(() => {
    if (!input || !d.input) {
      buttons[d.buttons.indexOf(d.buttons.find((b) => b.focus) ?? primary)]?.focus();
      return;
    }
    input.focus();
    const dot = value.lastIndexOf(".");
    if (d.input.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
</script>

<Modal title={d.title} width="420px" onclose={() => app.closeDialog("cancel")}>
  <div class="body">
    {#if d.message}<p>{d.message}</p>{/if}
    {#if d.input}
      <input
        class="input"
        bind:this={input}
        bind:value
        placeholder={d.input.placeholder}
        onkeydown={(e) => {
          if (e.key !== "Enter") return;
          // Consumed: focus goes back to the opener at once, and the key must not click it.
          e.preventDefault();
          app.closeDialog(primary.value, value);
        }}
      />
    {/if}
  </div>
  {#snippet footer()}
    {#each d.buttons as b, i (b.value)}
      <button class="btn" bind:this={buttons[i]} class:primary={b.primary} class:danger={b.danger} class:solid={b.danger} onclick={() => app.closeDialog(b.value, value)}>
        {b.label}
      </button>
    {/each}
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
</style>
