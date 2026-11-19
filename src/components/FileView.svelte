<script lang="ts">
  // A file view (#166): the whole `.http` file as one editable text, a tab of its own.
  // It and the file's request tabs edit the same document (the store's), so each shows
  // the other's edits: text typed here is read into the document after a short pause,
  // and any other change to the document renders the text again. Text that doesn't
  // parse leaves the document's file at its last valid state.
  import { tick, untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { GlobalVariable, HttpFile, PortabilityMark, Problem, Variable } from "../lib/types";
  import { basename, fileVariables, requestNames } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { sessionView } from "../lib/sessionView.svelte";
  import { portabilityLineMarks, ReferenceChecks, type OutsideScope } from "../lib/checks";
  import { checkUnderlines, fileUnderlines } from "../lib/codemirror/underlines";
  import { requestAt, requestBlocks, type OutlineEntry, type RequestBlock } from "../lib/codemirror/outline";
  import { EditorView } from "@codemirror/view";
  import { syntaxTree } from "@codemirror/language";
  import type { Text } from "@codemirror/state";
  import type { Tree } from "@lezer/common";
  import Badge from "./Badge.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import { setReadOnlyRegion } from "../lib/codemirror/readOnly";
  import { afterPause, fileView } from "../lib/textViews.svelte";
  import FileBanners from "./FileBanners.svelte";
  import Banner from "./Banner.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shortcutHint } from "../lib/commands";

  let { tab }: { tab: Tab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const dirty = $derived(app.isDocDirty(tab.path));
  const invalid = $derived(app.texts.isInvalid(tab.path, fileView));
  // Read-only while a request's Source view holds text that doesn't parse (#174).
  const lock = $derived(app.texts.lock(tab));
  setReadOnlyRegion(() => !!lock);
  const envSet = $derived(app.envSetFor(tab.path));
  const globals = sessionView<GlobalVariable[]>(() => api.sessionGlobals(), []);
  /** What every request of the file sees besides the file: one object while it's the same, so each request's references are looked at again only when they change. */
  const outside: OutsideScope = $derived({
    env: envVariables(envSet, app.envName),
    envName: app.envName,
    globals: Object.fromEntries((globals.current ?? []).map((g) => [g.name, g.value])),
  });
  /**
   * The file's variables and request names, as JSON: what `variables` follows, so an
   * edit that leaves them as they were (most do) doesn't give the editor new ones,
   * which would have it colour every reference again (#168).
   */
  const declared = $derived(doc ? JSON.stringify([fileVariables(doc.file), doc.file.header.variables, requestNames(doc.file)]) : null);
  // Every `@name` line is a File variable here; no request's Prompt variables or answers apply.
  const variables = $derived.by(() => {
    if (!declared) return null;
    const [fileVars, headerVars, names] = JSON.parse(declared) as [Variable[], Variable[], string[]];
    return {
      ...makeVarProvider({
        ...outside,
        fileVars,
        headerVars,
        requestVars: [],
        requestNames: names,
        exchange: (name: string) => app.exchangeShape(tab.path, name),
      }),
      findUsages: (name: string) => app.findUsages(name),
    };
  });

  /** The text shown: what the user typed, or the file rendered by the core. */
  let text = $state("");
  /** Whether the text has been shown (rendered, or as typed) since the view opened. */
  let shown = $state(false);
  let editor = $state<Editor>();

  /** The user typed: the text is kept here and in the document, which reads it shortly. */
  function typed(t: string) {
    text = t;
    void app.texts.edit(tab.path, fileView, t);
  }

  // The text follows the document (`follow`): its own typed text as it is, any other
  // change (an edit in a request tab) rendered again, shortly after, or at once when the
  // view first shows.
  $effect(() =>
    app.texts.follow(
      tab.path,
      fileView,
      (t) => {
        if (text !== t) text = t;
        shown = true;
      },
      untrack(() => shown),
    ),
  );

  /**
   * What the core found reading the text shown, and the text it read: what it reads as,
   * its problems, and the lines that behave differently in VS Code or Rider. Read a block
   * at a time (`app.texts.findings`), shortly after typing stops; the editor moves them
   * with its edits meanwhile. Raw state: a large file has thousands of marks, each read.
   */
  let found = $state.raw<{ text: string; file: HttpFile | null; problems: Problem[]; portability: PortabilityMark[] } | null>(null);
  $effect(() => {
    if (!shown) return;
    const read = text;
    return afterPause(
      () => app.texts.findings(tab.path, read).catch(() => ({ file: null, problems: [], portability: [] })),
      (findings) => (found = { text: read, ...findings }),
    );
  });
  /** Each request's Undefined variables and shared `# @name`, as its tab's strip finds them, kept between readings. */
  const references = new ReferenceChecks();
  // The core's problems, then those, each where it was found in the text (#165, #166).
  const underlines = $derived.by(() => {
    if (!found) return [];
    const problems = checkUnderlines(found.text, found.problems.map((problem) => ({ kind: "problem" as const, problem })));
    if (!found.file) return problems;
    return [...problems, ...fileUnderlines(found.file, references.of(found.file, outside))].sort((a, b) => a.from - b.from);
  });
  const marks = $derived(portabilityLineMarks(found?.portability ?? [], app.portabilityLevel));

  // The outline: the requests of the text shown. The one under the cursor is the
  // explorer's selection, and the one Send (⌘Enter) sends.
  // Read from the editor's own tree, which keeps the blocks an edit didn't touch, so a
  // keystroke reads only its own block again, and the outline's other entries stay
  // the objects they were (#168).
  let outlineOf = $state.raw<{ doc: Text; tree: Tree } | null>(null);
  const blocks = $derived(outlineOf ? requestBlocks(outlineOf.doc, outlineOf.tree) : []);
  /** The outline's entries: the same array while they're the same, so a keystroke doesn't have the outline compare its thousand. */
  let lastEntries: OutlineEntry[] = [];
  const entries = $derived.by(() => {
    // A request typed in has a new entry; it keeps the one it had while it reads the same, so its row stays.
    const kept = new Set(blocks.map((b) => b.entry));
    const next = blocks.map((b, i) => {
      const was = lastEntries[i];
      return was && !kept.has(was) && was.method === b.method && was.label === b.label ? was : b.entry;
    });
    if (next.length === lastEntries.length && next.every((e, i) => e === lastEntries[i])) return lastEntries;
    return (lastEntries = next);
  });
  let cursor = $state(0);
  const followCursor = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) cursor = u.state.selection.main.head;
    // Untracked: this runs inside whatever dispatched (an Editor effect among them), which mustn't come to depend on it.
    const tree = syntaxTree(u.state);
    if (tree !== untrack(() => outlineOf?.tree)) outlineOf = { doc: u.state.doc, tree };
  });
  const current = $derived(requestAt(blocks, cursor));
  const currentIndex = $derived(current?.index ?? null);
  /** The key of the request under the cursor, while the text reads as the file's requests. */
  const underCursor = $derived(!invalid && currentIndex !== null ? (doc?.file.requests[currentIndex]?._key ?? null) : null);
  $effect(() => app.setFileCursor(tab.id, currentIndex));

  function show(block: RequestBlock, focus: boolean) {
    editor?.revealAt(block.start, { focus });
  }

  // Asked to show a request (the explorer, `app.openFileView(path, { key })`): once the text is shown.
  $effect(() => {
    const want = app.fileRequestWanted;
    if (want?.tabId !== tab.id || !shown || !editor || !doc) return;
    app.fileRequestWanted = null;
    const block = blocks[doc.file.requests.findIndex((r) => r._key === want.key)];
    if (block) tick().then(() => show(block, false));
  });

  // Asked to show a line (`app.openFileView(path, { line })`): once the text is shown.
  $effect(() => {
    const want = app.fileLineWanted;
    if (want?.tabId !== tab.id || !shown || !editor) return;
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
    <FileBanners {doc} />
    {#if lock}
      <Banner severity="info">
        {lock.reason}
        {#snippet actions()}
          {#if lock.heldBy.kind === "request"}
            {@const key = lock.heldBy.key}
            <button class="btn small" onclick={() => app.openRequest(tab.path, { key })}>Show request</button>
          {/if}
        {/snippet}
      </Banner>
    {/if}
    <div class="crumbs">
      <Icon name="code" size={14} />
      <span class="file" use:tooltip={tab.path}>{basename(tab.path)}</span>
      <span class="spacer"></span>
      <!-- Back to a request's own tab (the request tab's File button comes here). -->
      <button
        class="btn small ghost"
        disabled={!underCursor}
        onclick={() => underCursor && app.openRequest(tab.path, { key: underCursor })}
        use:tooltip={underCursor ? "Open the request under the cursor in its own tab" : invalid ? "The text doesn't read as a file yet" : "Put the cursor in a request to open it in its own tab"}
      >
        <Icon name="file" size={14} />Request
      </button>
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
    {#if shown}
      <div class="file-body">
        <nav class="outline" aria-label="Outline">
          {#each entries as entry, i (entry)}
            <button class="entry" class:current={i === currentIndex} aria-current={i === currentIndex ? "true" : undefined} onclick={() => show(blocks[i], true)} use:tooltip={entry.label}>
              <Badge method={entry.method} />
              <span class="label ellipsis">{entry.label}</span>
            </button>
          {:else}
            <div class="none muted">No requests</div>
          {/each}
        </nav>
        <div class="file-code">
          <Editor
            bind:this={editor}
            value={text}
            onchange={typed}
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
    /* Its size is the layout's, not its entries': typing in the text lays out and paints none of it (#168). */
    contain: strict;
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
    contain: strict;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
</style>
