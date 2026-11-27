<script lang="ts">
  // A file view (#166): the whole `.http` file as one editable text, a tab of its own.
  // It and the file's request tabs edit the same document (the store's), so each shows
  // the other's edits: text typed here is read into the document after a short pause,
  // and any other change to the document renders the text again. Text that doesn't
  // parse leaves the document's file at its last valid state.
  import { onDestroy, tick, untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { GlobalVariable, HttpFile, PortabilityMark, Problem, Variable } from "../lib/types";
  import { basename, fileVariables, requestNames } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { sessionView } from "../lib/sessionView.svelte";
  import { portabilityLineMarks, ReferenceChecks, type OutsideScope } from "../lib/checks";
  import { checkUnderlines, fileUnderlines } from "../lib/codemirror/underlines";
  import { inDocument } from "../lib/codemirror/lineEndings";
  import { requestAt, requestBlocks, type OutlineEntry, type RequestBlock } from "../lib/codemirror/outline";
  import { EditorView, ViewPlugin } from "@codemirror/view";
  import { syntaxTree } from "@codemirror/language";
  import type { EditorState, Text } from "@codemirror/state";
  import { caretFact } from "../lib/fileFacts";
  import type { Tree } from "@lezer/common";
  import Badge from "./Badge.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import { setReadOnlyRegion } from "../lib/codemirror/readOnly";
  import { afterPause, fileView, VIEW_REFRESH_DELAY_MS } from "../lib/textViews.svelte";
  import FileBanners from "./FileBanners.svelte";
  import Banner from "./Banner.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shortcutHint } from "../lib/commands";
  import { editorMemoryKey } from "../lib/editorMemory";
  import { rovingList } from "../lib/rovingList";

  let { tab }: { tab: Tab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const dirty = $derived(app.isDocDirty(tab.path));
  const invalid = $derived(app.texts.isInvalid(tab.path, fileView));
  /** Where the text stops parsing: what the note says, and where its button goes. */
  const firstError = $derived(app.texts.firstError(tab.path, fileView));
  const lineBreak = $derived(app.texts.lineBreak(tab.path));
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
      (t, how) => {
        // Text the user reverted to goes in as a change Undo takes back.
        if (how.undoable && text !== t) editor?.replace(t);
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
  /** The body files the Problems panel found missing (the shell looks on disk), by line of the file's text as it then was. */
  const missingFiles = $derived((app.problems.files[tab.path]?.problems ?? []).filter((p) => p.code === "missing-file"));
  const underlines = $derived.by(() => {
    if (!found) return [];
    const problems = checkUnderlines(found.text, [...found.problems, ...missingFiles].map((problem) => ({ kind: "problem" as const, problem })));
    const all = found.file ? [...problems, ...fileUnderlines(found.file, references.of(found.file, outside))].sort((a, b) => a.from - b.from) : problems;
    // In a file with mixed endings the text keeps each `\r\n`; the editor's document has one character per break.
    return lineBreak ? inDocument(found.text, all) : all;
  });
  const marks = $derived(portabilityLineMarks(found?.portability ?? [], app.portability));

  // The outline: the requests of the text shown. The one under the cursor is the
  // explorer's selection, and the one Send (⌘Enter) sends.
  // Read from the editor's own tree, which keeps the blocks an edit didn't touch, so a
  // keystroke reads only its own block again, and the outline's other entries stay
  // the objects they were (#168). It shows the text once the editor has been still for
  // a moment (`VIEW_REFRESH_DELAY_MS`), as the explorer's selection follows it: typing
  // that makes a request appear and go (`@` at the top reads as a request line until
  // ` = ` follows) doesn't redraw the outline, and the explorer, on each keystroke.
  interface EditorAt {
    doc: Text;
    tree: Tree;
    cursor: number;
  }
  /** The editor as of its last update. */
  let latest: EditorAt | null = null;
  let settling: ReturnType<typeof setTimeout> | undefined;
  /** The editor as the outline shows it. */
  let outlineOf = $state.raw<EditorAt | null>(null);
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
  const followCursor = EditorView.updateListener.of((u) => {
    const tree = syntaxTree(u.state);
    if (!u.selectionSet && !u.docChanged && tree === latest?.tree) return;
    latest = { doc: u.state.doc, tree, cursor: u.state.selection.main.head };
    clearTimeout(settling);
    // Not from inside this update (it may run in an Editor effect, which mustn't come to depend on the outline).
    settling = setTimeout(() => (outlineOf = latest), outlineOf ? VIEW_REFRESH_DELAY_MS : 0);
  });
  onDestroy(() => clearTimeout(settling));
  // The caret's line and column, for the bottom bar (#232): from the start, and as the
  // main selection's head moves (keys, clicks, typing, a jump from the Problems panel).
  const publishCaret = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    app.setFileCaret(tab.id, caretFact(line, head - line.from));
  };
  const trackCaret = ViewPlugin.define((view) => {
    publishCaret(view.state);
    return {
      update(u) {
        if (u.selectionSet || u.docChanged) publishCaret(u.state);
      },
    };
  });
  const current = $derived(outlineOf ? requestAt(blocks, outlineOf.cursor) : null);
  const currentIndex = $derived(current?.index ?? null);
  const currentEntry = $derived(currentIndex === null ? null : entries[currentIndex]);
  /** The key of the request under the cursor, while the text reads as the file's requests. */
  const underCursor = $derived(!invalid && currentIndex !== null ? (doc?.file.requests[currentIndex]?._key ?? null) : null);
  $effect(() => app.setFileCursor(tab.id, currentIndex));

  /** The request under the cursor now, though the outline hasn't caught up (Send). */
  function requestNow(): number | null {
    return latest ? (requestAt(requestBlocks(latest.doc, latest.tree), latest.cursor)?.index ?? null) : null;
  }

  /** Puts the cursor at `block`'s request, which Send sends from now on (not once the outline catches up). */
  function show(block: RequestBlock, focus: boolean) {
    editor?.revealAt(block.start, { focus });
    app.setFileCursor(tab.id, requestNow());
  }

  // The outline is a list (`rovingList`): one stop in the Tab order (the request under the
  // cursor, until a row is focused), and the arrow keys move through it. A click shows a
  // request and leaves focus in the list; Enter or a double-click goes into the text.
  let outline = $state<HTMLElement>();
  const blockOf = (row: HTMLElement) => blocks[[...(outline?.querySelectorAll(".list-row") ?? [])].indexOf(row)];
  const showRow = (row: HTMLElement, focus: boolean) => {
    const block = blockOf(row);
    if (block) show(block, focus);
  };
  // The entry of the request under the cursor stays in sight as the cursor moves through a long file.
  $effect(() => {
    if (!currentEntry || !outline) return;
    tick().then(() => outline?.querySelector<HTMLElement>(".list-row.current")?.scrollIntoView({ block: "nearest" }));
  });

  let folding = $state(false);
  let canFoldAll = $state(true);
  /** The request under the cursor can't be opened: why, for the button's tooltip. */
  const noRequest = $derived(underCursor ? "" : invalid ? "The text doesn't parse, so its requests are as they last read" : "Put the cursor in a request to open it in its own tab");

  // Asked to show a request (the explorer, `app.openFileView(path, { key })`): once the text is shown.
  $effect(() => {
    const want = app.fileRequestWanted;
    // Once the outline has read the text too: it finds the request's block.
    if (want?.tabId !== tab.id || !shown || !editor || !doc || !outlineOf) return;
    app.fileRequestWanted = null;
    const block = blocks[doc.file.requests.findIndex((r) => r._key === want.key)];
    if (block) tick().then(() => show(block, false));
  });

  // Asked to show a line (`app.openFileView(path, { line })`): once the text is shown.
  $effect(() => {
    const want = app.fileLineWanted;
    if (want?.tabId !== tab.id || !shown || !editor) return;
    app.fileLineWanted = null;
    tick().then(() => editor?.revealLine(want.line, { caret: want.column ?? true }));
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
      <button class="icon-btn" aria-label="Fold all" use:tooltip={canFoldAll ? undefined : "Too large to fold all"} aria-disabled={!canFoldAll || folding} onclick={() => canFoldAll && !folding && editor?.fold(true)}><Icon name="fold" size={14} /></button>
      <button class="icon-btn" aria-label="Unfold all" use:tooltip onclick={() => editor?.fold(false)}><Icon name="unfold" size={14} /></button>
      <!-- Unavailable with a reason: aria-disabled, so the reason is reachable from the keyboard (controls.md). -->
      <button
        class="btn small ghost"
        aria-disabled={!underCursor}
        onclick={() => {
          // The one under the cursor now, though the outline hasn't caught up.
          const index = requestNow();
          const key = !invalid && index !== null ? doc?.file.requests[index]?._key : underCursor;
          if (key) void app.openRequest(tab.path, { key });
        }}
        use:tooltip={noRequest || "Open the request under the cursor in its own tab"}
      >
        <Icon name="file" size={14} />Request
      </button>
      <button class="btn small" disabled={!dirty} onclick={() => app.save(tab.path)} use:tooltip={`Save (${shortcutHint("save")})`}>
        <Icon name="save" size={14} />Save{#if dirty}<span class="dot"></span>{/if}
      </button>
    </div>
    <!-- One line either way, so the text below doesn't move as typing passes through text that doesn't parse. -->
    <div class="note" class:muted={!invalid} class:invalid role="status">
      {#if invalid}
        <Icon name="alert" size={12} />
        <span class="ellipsis">
          {#if firstError}<span class="line">Line {firstError.line}</span> {firstError.message}{:else}This text doesn't parse.{/if}
          Until it does, its requests stay as they last read.
        </span>
        {#if firstError}
          <button class="link" onclick={() => editor?.revealLine(firstError.line, { caret: firstError.column })}>Go to line {firstError.line}</button>
        {/if}
      {:else}
        <span class="ellipsis">The whole of <code>{basename(tab.path)}</code> as it's written. Edits here show in its requests' tabs, and theirs here.</span>
      {/if}
    </div>
    {#if shown}
      <div class="file-body">
        <nav class="outline" aria-label="Outline" bind:this={outline}>
          {#if entries.length}
            <div class="rows" role="list" aria-label="Requests" use:rovingList={{ activate: (row) => showRow(row, true) }}>
              <!-- Nothing in a row reads its place: a request added or removed above moves the rest without touching them (#168). -->
              {#each entries as entry (entry)}
                <!-- The list's keys are rovingList's; a double-click goes into the text, as Enter does. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <div
                  role="listitem"
                  tabindex="-1"
                  class="list-row"
                  class:current={entry === currentEntry}
                  aria-current={entry === currentEntry ? "true" : undefined}
                  onclick={(e) => showRow(e.currentTarget, false)}
                  ondblclick={(e) => showRow(e.currentTarget, true)}
                  use:tooltip={entry.label}
                >
                  <Badge method={entry.method} />
                  <span class="label ellipsis">{entry.label}</span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="none muted">No requests</div>
          {/if}
        </nav>
        <div class="file-code">
          <Editor
            bind:this={editor}
            value={text}
            onchange={typed}
            onsend={() => {
              // The request under the cursor now, not when the cursor last settled.
              app.setFileCursor(tab.id, requestNow());
              void app.send(tab.id);
            }}
            freshHistory
            language="http"
            {variables}
            {underlines}
            lineMarks={marks}
            {lineBreak}
            bind:folding
            bind:canFoldAll
            extensions={[followCursor, trackCaret]}
            memory={editorMemoryKey(tab.id, "file")}
            label={`${basename(tab.path)} as text`}
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
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-1);
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
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
    font-size: 11.5px;
    line-height: 16px;
    padding: var(--space-2) var(--space-4);
  }
  .note.invalid {
    color: var(--text-2);
  }
  .note.invalid :global(svg) {
    flex: none;
    color: var(--danger);
  }
  .note .line {
    font-family: var(--mono);
    color: var(--muted);
  }
  .note .link {
    flex: none;
    font-size: inherit;
  }
  code {
    font-family: var(--mono);
    font-size: 11px;
  }
  .file-body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--space-2);
    margin: 0 var(--space-4) var(--space-4);
  }
  .outline {
    flex: none;
    width: 200px;
    /* Its size is the layout's, not its entries': typing in the text lays out and paints none of it (#168). */
    contain: strict;
    overflow-y: auto;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* A narrow column: rows hold a method badge and a label. */
  .outline .list-row {
    flex: none;
    padding: 0 var(--space-2);
  }
  .list-row .label {
    min-width: 0;
  }
  .none {
    font-size: 11.5px;
    padding: var(--space-2);
  }
  .file-code {
    flex: 1;
    min-width: 0;
    min-height: 0;
    /* Laid out and painted apart from the outline (#168), but not size-contained:
       with `strict`, WebKit (the app's webview) sometimes resolves the editor's
       height: 100% as its content height, so the text grows past this box and
       neither the wheel nor the cursor can scroll it. */
    contain: content;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
</style>
