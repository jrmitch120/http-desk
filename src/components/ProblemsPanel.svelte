<!--
  The Problems panel (in the panel area, PanelArea.svelte): every `.http` file in the
  workspace with problems or lines that behave differently in VS Code or Rider
  (`app.problems`, read by the shell off the main thread), grouped by file, each with
  a summary of those lines. Each entry shows its line and message; clicking it opens
  the file's file view at that line. Open documents are listed as they are in the app,
  unsaved edits included. Portability notes show at `app.portabilityLevel`.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { relativePath } from "../lib/http";
  import { problemFiles } from "../lib/problemsList";
  import Icon from "./Icon.svelte";

  const files = $derived(problemFiles(Object.values(app.problems.files), app.portabilityLevel));
  const label = (path: string) => (app.root ? relativePath(app.root, path).replace(/^\.\//, "") : path);
</script>

<div class="problems">
  {#if files.length}
    <div class="items">
      {#each files as f (f.path)}
        <div class="group" role="group" aria-label={label(f.path)}>
          <div class="file">
            <Icon name="file" size={12} /><span class="name selectable">{label(f.path)}</span>
            {#each f.summary as line (line)}<span class="summary" role="note">{line}</span>{/each}
          </div>
          <ol>
            {#each f.entries as e, i (i)}
              <li>
                <button class="row {e.tone}" onclick={() => app.openFileView(f.path, { line: e.line })}>
                  <span class="icon"><Icon name={e.tone === "note" ? "info" : "alert"} size={12} /></span>
                  <span class="line">Line {e.line}</span>
                  <span class="message">{e.message}</span>
                </button>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty-state muted small">No problems in the workspace's .http files.</div>
  {/if}
</div>

<style>
  .problems {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .items {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .group + .group {
    margin-top: 6px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px 2px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .file .name {
    color: var(--text-2);
    font-weight: 600;
  }
  .summary {
    color: var(--muted);
  }
  .summary::before {
    content: "·";
    margin-right: 6px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 3px 12px 3px 24px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--hover);
  }
  .icon {
    display: inline-flex;
    align-self: center;
    flex: none;
  }
  .error .icon {
    color: var(--danger);
  }
  .warning .icon {
    color: var(--warning);
  }
  .note .icon {
    color: var(--info);
  }
  .line {
    flex: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
  }
  .message {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 12px;
  }
</style>
