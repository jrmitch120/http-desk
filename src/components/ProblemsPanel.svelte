<!--
  The Problems panel (in the panel area, PanelArea.svelte): every `.http` file in the
  workspace with problems or lines that behave differently in VS Code or Rider
  (`app.problems`, read by the shell off the main thread), grouped by file, each with
  a summary of those lines. Each entry shows its line and message; clicking it opens
  the file's file view at that line. Open documents are listed as they are in the app,
  unsaved edits included. Portability notes show as `app.portability` says: only for
  the editors turned on, at its level.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { relativePath } from "../lib/http";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  const files = $derived(app.problems.list);
  const label = (path: string) => (app.root ? relativePath(app.root, path).replace(/^\.\//, "") : path);
  const TONES = { error: "Error", warning: "Warning", note: "Note" };
  /** A row's whole message as its tooltip, only while the row cuts it short. */
  const clipped = (row: HTMLElement, message: string) =>
    tooltip(row, () => {
      const el = row.querySelector<HTMLElement>(".message");
      return el && el.scrollWidth > el.clientWidth ? message : null;
    });
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
                <button class="list-row {e.tone}" onclick={() => app.openFileView(f.path, { line: e.line, column: e.column })} use:clipped={e.message}>
                  <span class="icon" role="img" aria-label={TONES[e.tone]}><Icon name={e.tone === "note" ? "info" : "alert"} size={12} /></span>
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
    padding: var(--space-1) 0;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* A group off screen isn't laid out or painted: a workspace may list thousands of entries. */
  .group {
    content-visibility: auto;
    contain-intrinsic-size: auto 60px;
  }
  .group + .group {
    margin-top: var(--space-2);
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3) 0;
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
    margin-right: var(--space-2);
  }
  /* Under their file's name. */
  .list-row {
    padding-left: var(--space-6);
  }
  .icon {
    display: inline-flex;
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
