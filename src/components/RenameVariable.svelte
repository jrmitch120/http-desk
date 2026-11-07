<script lang="ts">
  // The Rename variable form (app.renaming): a new name for an environment
  // variable and, with "Update references", a preview of the files whose
  // `{{name}}` references change (from Find usages). There is no undo beyond
  // version control, so the preview is shown before anything is written.
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import { errorMessage } from "../lib/api";
  import { relativePath } from "../lib/http";
  import { renameNameError, renamePreview } from "../lib/rename";
  import type { Usage } from "../lib/types";
  import Modal from "./Modal.svelte";
  import Checkbox from "./Checkbox.svelte";
  import Banner from "./Banner.svelte";

  const old = app.renaming!.name;
  let name = $state(old);
  let references = $state(true);
  let input: HTMLInputElement | undefined = $state();
  /** What Find usages found: null while searching. */
  let usages = $state<Usage[] | null>(null);
  let searchError = $state<string | null>(null);

  const error = $derived(renameNameError(name.trim(), old, app.envSet));
  const preview = $derived(usages ? renamePreview(usages) : []);
  const ready = $derived(!!name.trim() && name.trim() !== old && !error && (!references || usages !== null));
  const where = (path: string) => (app.root ? relativePath(app.root, path) : path);

  onMount(() => {
    input?.select();
    app.searchUsages(old).then(
      (found) => (usages = found),
      (e) => (searchError = errorMessage(e)),
    );
  });

  function submit() {
    if (!ready) return;
    app.closeRenaming({ name: name.trim(), usages: references ? usages : null });
  }
</script>

<Modal title="Rename variable" width="480px" onclose={() => app.closeRenaming(null)}>
  <div class="body">
    <div class="field">
      <label class="label" for="rename-name">New name</label>
      <input
        id="rename-name"
        class="input mono"
        bind:this={input}
        bind:value={name}
        spellcheck="false"
        autocomplete="off"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "rename-name-error" : undefined}
        onkeydown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          submit();
        }}
      />
      {#if error}<span class="field-error" id="rename-name-error" role="alert">{error}</span>{/if}
      <span class="help">Renamed in Shared and every environment that has it.</span>
    </div>
    <div class="field">
      <Checkbox checked={references} onchange={(on) => (references = on)}>Update references</Checkbox>
      {#if references}
        {#if searchError}
          <Banner severity="error" inline>Could not search for references: {searchError}</Banner>
        {:else if usages === null}
          <span class="help">Searching for <span class="mono">{`{{${old}}}`}</span>…</span>
        {:else if !preview.length}
          <span class="help">Nothing references <span class="mono">{`{{${old}}}`}</span>.</span>
        {:else}
          <span class="help">Every <span class="mono">{`{{${old}}}`}</span> in:</span>
          <ul class="files" aria-label="Files to update">
            {#each preview as row (row.path)}
              <li><span class="mono ellipsis">{where(row.path)}</span><span class="count">{row.detail}</span></li>
            {/each}
          </ul>
          <span class="help">Files are saved at once, except those with unsaved edits: they get the change and stay unsaved. There is no undo; use version control to go back.</span>
        {/if}
      {/if}
    </div>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => app.closeRenaming(null)}>Cancel</button>
    <button class="btn primary" disabled={!ready} onclick={submit}>Rename</button>
  {/snippet}
</Modal>

<style>
  .body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .label {
    font-size: 12px;
    color: var(--muted);
  }
  .input {
    width: 100%;
  }
  .help {
    font-size: 12px;
    color: var(--muted);
  }
  .field-error {
    font-size: 12px;
    color: var(--danger);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    width: 100%;
    max-height: 180px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  .files li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 10px;
  }
  .files .mono {
    flex: 1;
    min-width: 0;
  }
  .count {
    flex: none;
    font-size: 12px;
    color: var(--muted);
  }
</style>
