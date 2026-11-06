<script lang="ts">
  // Confirm / prompt dialog driven by app.dialog (remounted for each dialog).
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import Modal from "./Modal.svelte";

  let value = $state(app.dialog?.input?.value ?? "");
  let input: HTMLInputElement | undefined = $state();

  // Once per dialog: re-selecting on every keystroke would replace what was typed.
  onMount(() => {
    if (!input || !app.dialog?.input) return;
    input.focus();
    const dot = value.lastIndexOf(".");
    if (app.dialog.input.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });

  const d = $derived(app.dialog!);
  const primary = $derived(d.buttons.find((b) => b.primary) ?? d.buttons[d.buttons.length - 1]);
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
        onkeydown={(e) => e.key === "Enter" && app.closeDialog(primary.value, value)}
      />
    {/if}
  </div>
  {#snippet footer()}
    {#each d.buttons as b (b.value)}
      <button class="btn" class:primary={b.primary} class:danger={b.danger} class:solid={b.danger} onclick={() => app.closeDialog(b.value, value)}>
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
