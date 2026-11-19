<script lang="ts">
  // A file view (#166): the whole `.http` file as one editable text, a tab of its own.
  // It and the file's request tabs edit the same document (the store's), so each shows
  // the other's edits: text typed here is read into the document after a short pause,
  // and any other change to the document renders the text again. Text that doesn't
  // parse leaves the document's file at its last valid state.
  import { tick, untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { GlobalVariable, PortabilityMark, Problem } from "../lib/types";
  import { basename, fileVariables, requestNames } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { sessionView } from "../lib/sessionView.svelte";
  import { portabilityLineMarks } from "../lib/checks";
  import { checkUnderlines } from "../lib/codemirror/underlines";
  import { requestAt, requestBlocks, type RequestBlock } from "../lib/codemirror/outline";
  import { EditorView } from "@codemirror/view";
  import Badge from "./Badge.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import Banner from "./Banner.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shortcutHint } from "../lib/commands";

  let { tab }: { tab: Tab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const dirty = $derived(app.isDocDirty(tab.path));
  const invalid = $derived(app.isFileTextInvalid(tab.path));
  const envSet = $derived(app.envSetFor(tab.path));
  const globals = sessionView<GlobalVariable[]>(() => api.sessionGlobals(), []);
  // Every `@name` line is a File variable here; no request's Prompt variables or answers apply.
  const variables = $derived.by(() => {
    if (!doc) return null;
    return {
      ...makeVarProvider({
        env: envVariables(envSet, app.envName),
        fileVars: fileVariables(doc.file),
        headerVars: doc.file.header.variables,
        requestVars: [],
        globals: Object.fromEntries((globals.current ?? []).map((g) => [g.name, g.value])),
        envName: app.envName,
        requestNames: requestNames(doc.file),
        exchange: (name: string) => app.exchangeShape(tab.path, name),
      }),
      findUsages: (name: string) => app.findUsages(name),
    };
  });

  /** The text shown: what the user typed, or the file rendered by the core. */
  let text = $state("");
  /** The file (as JSON) `text` is up to date with; null until the text is first shown. */
  let textOf = $state<string | null>(null);
  let editor = $state<Editor>();

  // The text follows the document. A change that came from this view (the text the
  // user typed, read into the document) shows that text as it is, so the editor isn't
  // touched and its cursor never jumps. Any other change (an edit in a request tab)
  // renders the file again, shortly after, or at once when the view first shows.
  $effect(() => {
    if (!doc) return;
    const snap = JSON.stringify(doc.file);
    const typed = app.fileText(tab.path);
    if (typed) {
      text = typed.text;
      textOf = snap;
      return;
    }
    const t = setTimeout(
      async () => {
        const rendered = await app.fileTextFor(tab.path).catch((e) => `# ${e}`);
        if (rendered === null || JSON.stringify(app.docs[tab.path]?.file) !== snap) return;
        text = rendered;
        textOf = snap;
      },
      untrack(() => textOf) === null ? 0 : 120,
    );
    return () => clearTimeout(t);
  });

  /** What the core finds reading the text shown: its problems, and the lines that behave differently in VS Code or Rider. */
  let problems = $state<Problem[]>([]);
  let portability = $state<PortabilityMark[]>([]);
  $effect(() => {
    if (textOf === null) return;
    const shown = text;
    let stale = false;
    const t = setTimeout(async () => {
      const [parsed, marks] = await Promise.all([api.parseFileText(shown).catch(() => null), api.portabilityText(shown).catch(() => [])]);
      if (stale) return;
      problems = parsed?.problems ?? [];
      portability = marks;
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  });
  const underlines = $derived(checkUnderlines(text, problems.map((problem) => ({ kind: "problem" as const, problem }))));
  const marks = $derived(portabilityLineMarks(portability, app.portabilityLevel));

  // The outline: the requests of the text shown. The one under the cursor is the
  // explorer's selection, and the one Send (⌘Enter) sends.
  const blocks = $derived(requestBlocks(text));
  let cursor = $state(0);
  const followCursor = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) cursor = u.state.selection.main.head;
  });
  const current = $derived(requestAt(blocks, cursor));
  $effect(() => app.setFileCursor(tab.id, current?.index ?? null));

  function show(block: RequestBlock, focus: boolean) {
    editor?.revealAt(block.start, { focus });
  }

  // Asked to show a request (the explorer, `app.openFileView(path, { key })`): once the text is shown.
  $effect(() => {
    const want = app.fileRequestWanted;
    if (want?.tabId !== tab.id || textOf === null || !editor || !doc) return;
    app.fileRequestWanted = null;
    const block = blocks[doc.file.requests.findIndex((r) => r._key === want.key)];
    if (block) tick().then(() => show(block, false));
  });

  // Asked to show a line (`app.openFileView(path, { line })`): once the text is shown.
  $effect(() => {
    const want = app.fileLineWanted;
    if (want?.tabId !== tab.id || textOf === null || !editor) return;
    app.fileLineWanted = null;
    tick().then(() => editor?.revealLine(want.line));
  });
</script>

{#if tab.restoring}
  <!-- A restored file view whose file is still being read. -->
  <div class="empty-state" aria-busy="true">Opening {tab.restoring.name}…</div>
{:else if !doc}
  <div class="empty-state">This file is no longer available.</div>
{:else}
  <div class="file-view">
    {#if doc.missing}
      <Banner severity="error">{basename(tab.path)} was deleted or moved on disk. Saving will recreate it.</Banner>
    {:else if doc.externalChange}
      <Banner severity="warning">
        {basename(tab.path)} changed on disk while you have unsaved edits.
        {#snippet actions()}
          <button class="btn small" onclick={() => app.reload(tab.path)}>Reload from disk</button>
          <button class="btn small" onclick={() => (doc.externalChange = false)}>Keep my version</button>
        {/snippet}
      </Banner>
    {/if}
    <div class="crumbs">
      <Icon name="code" size={14} />
      <span class="file" use:tooltip={tab.path}>{basename(tab.path)}</span>
      <span class="spacer"></span>
      <button class="btn small" disabled={!dirty} onclick={() => app.save(tab.path)} use:tooltip={`Save (${shortcutHint("save")})`}>
        <Icon name="save" size={14} />Save{#if dirty}<span class="dot"></span>{/if}
      </button>
    </div>
    <div class="note muted">
      {#if invalid}
        This text doesn't read as a file yet. Until it does, its requests stay as they last read.
      {:else}
        The whole of <code>{basename(tab.path)}</code> as it's written. Edits here show in its requests' tabs, and theirs here.
      {/if}
    </div>
    {#if textOf !== null}
      <div class="file-body">
        <nav class="outline" aria-label="Outline">
          {#each blocks as block (block.index)}
            <button class="entry" class:current={block === current} aria-current={block === current ? "true" : undefined} onclick={() => show(block, true)} use:tooltip={block.label}>
              <Badge method={block.method} />
              <span class="label ellipsis">{block.label}</span>
            </button>
          {:else}
            <div class="none muted">No requests</div>
          {/each}
        </nav>
        <div class="file-code">
          <Editor
            bind:this={editor}
            value={text}
            onchange={(t) => app.editFileText(tab.path, t)}
            onsend={() => app.send(tab.id)}
            freshHistory
            language="http"
            {variables}
            {underlines}
            lineMarks={marks}
            extensions={followCursor}
          />
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .file-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px 4px 16px;
    color: var(--muted);
    flex: none;
  }
  .file {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .note {
    font-size: 11.5px;
    padding: 6px 16px 8px;
  }
  code {
    font-family: var(--mono);
    font-size: 11px;
  }
  .file-body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 8px;
    margin: 0 16px 16px;
  }
  .outline {
    flex: none;
    width: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    flex: none;
    padding: 0 6px;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .entry:hover {
    background: var(--hover);
    color: var(--text);
  }
  .entry.current {
    background: var(--accent-soft);
    border-left-color: var(--accent);
    color: var(--text);
  }
  .entry .label {
    min-width: 0;
  }
  .none {
    font-size: 11.5px;
    padding: 6px;
  }
  .file-code {
    flex: 1;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
</style>
