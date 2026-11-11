<!--
  The response viewer's Body tab: the view switch (Pretty/Raw, Hex, Preview),
  search, folding and wrap, the JSONPath filter bar, and the body itself
  (an editor, or a preview). JSON bodies add Copy path to the editor's
  edit menu. The state behind it (rendered text, filter, shape) is the
  viewer's BodyView, so it outlives a switch to another tab.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { KIND_INFO, type BodyMode, type BodyView } from "../lib/bodyView.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import ResponseFilter from "./ResponseFilter.svelte";
  import { addMenuItems } from "../lib/editMenu";
  import { pathInPieces } from "../lib/jsonpath";
  import { writeClipboard } from "../lib/clipboard";
  import { errorMessage } from "../lib/api";
  import type { Text } from "@codemirror/state";
  import type { HttpResponse } from "../lib/types";
  import { formatShortcut, type Shortcut } from "../lib/platform";

  // The editor's own find (CodeMirror's Mod-f), not an app command.
  const SEARCH: Shortcut = { mod: true, key: "f" };

  interface Props {
    res: HttpResponse;
    view: BodyView;
    mode: BodyMode;
    wrap: boolean;
    filter: string;
  }
  let { res, view, mode = $bindable(), wrap = $bindable(), filter = $bindable() }: Props = $props();

  let editor: Editor | undefined = $state();
  /** Fold all is parsing the body before it folds; and whether the body is small enough for Fold all at all. */
  let folding = $state(false);
  let canFoldAll = $state(true);

  const kind = $derived(view.kind);
  const isBinary = $derived(view.isBinary);
  const effectiveMode = $derived(view.effectiveMode);
  const filtered = $derived(view.filtered);
  const previewUrl = $derived(view.previewUrl);
  const ct = $derived((res.contentType ?? "").toLowerCase());
  /** Whether the body shows wrapped: as the tab chose, or always when its lines are too long to unwrap. */
  const wrapped = $derived(wrap || !view.canUnwrap);

  // Raw and Preview are each built the first time they're shown for a response,
  // then stay mounted and are switched by hiding one: going back to Raw doesn't
  // rebuild the editor (it keeps its scroll, find bar and colouring) and going
  // back to Preview doesn't reload the page. Nothing is built for a view that
  // was never shown (an image opened in Preview has no Hex editor behind it).
  const showingPreview = $derived(view.showingPreview);
  let previewShownFor = $state<string | null>(null);
  let editorShownFor = $state<string | null>(null);
  $effect(() => {
    if (showingPreview) previewShownFor = res.id;
    else editorShownFor = res.id;
  });
  const mountPreview = $derived(showingPreview || (previewShownFor === res.id && view.previewStaysMounted));
  const mountEditor = $derived(!showingPreview || editorShownFor === res.id);

  const viewOptions = $derived<SegmentedOption<BodyMode>[]>([
    ...(view.canPretty && !isBinary ? [{ value: "pretty" as const, label: "Pretty" }] : []),
    { value: "raw", label: isBinary ? "Hex" : "Raw" },
    ...(view.canPreview ? [{ value: "preview" as const, label: "Preview" }] : []),
  ]);

  // "Copy path" in the body editor's edit menu, after Copy and Select all (JSON
  // bodies only). Paths are of the text on screen, so not while filter matches show.
  const jsonBody = $derived(kind === "json" && !isBinary);
  function bodyMenu(e: MouseEvent) {
    if (!jsonBody || !editor || !(e.target as HTMLElement).closest?.(".cm-editor")) return;
    const ed = editor;
    const offset = ed.caretForMenu(e);
    const doc = ed.document();
    if (doc) addMenuItems(e, [{ label: "Copy path", icon: "code", disabled: !!filtered, action: () => void copyPath(doc, offset) }]);
  }
  // The body is read up to the caret a slice at a time (a large one takes a
  // moment), so the path goes on the clipboard through the shell: a webview
  // lets a page write to it only while handling a click.
  async function copyPath(doc: Text, offset: number) {
    const path = await pathInPieces(doc.iter(), offset);
    if (path === null) return app.toast("error", "There's no JSON value at the cursor");
    try {
      await writeClipboard(path);
      app.toast("success", `Copied ${path}`);
    } catch (e) {
      app.toast("error", `Couldn't copy the path: ${errorMessage(e)}`);
    }
  }
</script>

<div class="toolbar">
  <!-- Filter matches are always pretty-printed, so the view is fixed while they show. -->
  <!-- Plain text has only Raw, so no switch; a binary body keeps its single "Hex" so the view is named. -->
  {#if viewOptions.length > 1 || isBinary}
    <span class="tip" use:tooltip={filtered ? "Filter matches are always pretty-printed" : ""}>
      <SegmentedControl label="Response view" options={viewOptions} value={filtered ? "pretty" : effectiveMode} disabled={!!filtered} onchange={(m) => (mode = m)} />
    </span>
  {/if}
  {#if !isBinary}<span class="lang muted">{kind.toUpperCase()}</span>{/if}
  <span class="spacer"></span>
  {#if effectiveMode !== "preview"}
    <button class="icon-btn" aria-label="Search" use:tooltip={`Search (${formatShortcut(SEARCH)})`} onclick={() => editor?.openSearch()}><Icon name="search" size={14} /></button>
    {#if kind === "json" || kind === "xml"}
      {#if folding}<span class="folding muted" role="status"><span class="spinner"></span>Folding…</span>{/if}
      <!-- Above the limit, folding everything would freeze the window; the filter narrows a large body instead. -->
      <span class="tip" use:tooltip={canFoldAll ? "" : view.canFilter ? "Too large to fold all. Use the filter to narrow it down" : "Too large to fold all"}>
        <button class="icon-btn" aria-label="Fold all" use:tooltip={canFoldAll ? undefined : null} disabled={!canFoldAll || folding} onclick={() => editor?.fold(true)}><Icon name="fold" size={14} /></button>
      </span>
      <button class="icon-btn" aria-label="Unfold all" use:tooltip onclick={() => editor?.fold(false)}><Icon name="unfold" size={14} /></button>
    {/if}
    <!-- A line too long to draw unwrapped (#119) keeps the body wrapped; `wrap` stays the tab's choice. -->
    <span class="tip" use:tooltip={view.canUnwrap ? "" : "Lines too long to unwrap"}>
      <button class="icon-btn" class:active={wrapped} aria-label="Wrap lines" use:tooltip={view.canUnwrap ? undefined : null} disabled={!view.canUnwrap} onclick={() => (wrap = !wrap)}><Icon name="wrap" size={14} /></button>
    </span>
  {/if}
</div>
{#if view.canFilter}
  <div class="filter-row">
    <ResponseFilter value={filter} onchange={(v) => (filter = v)} matches={filtered?.matches ?? null} error={view.filterError} shape={view.shape} needshape={() => view.loadShape()} />
  </div>
{/if}
<!-- Adds Copy path to the body editor's edit menu. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="body" class:long-lines={view.longLines} oncontextmenu={bodyMenu}>
  {#if mountPreview}
    <div class="pane" class:hidden={!showingPreview}>
      {#if view.previewError}
        <div class="empty-state small">{view.previewError}</div>
      {:else if !previewUrl}
        <div class="empty-state small" role="status"><span class="spinner"></span>Loading…</div>
      {:else if kind === "html"}
        <iframe title="HTML preview" sandbox="" src={previewUrl}></iframe>
      {:else if kind === "image"}
        <div class="preview-img"><img src={previewUrl} alt="Response preview" /></div>
      {:else if kind === "pdf"}
        <iframe title="PDF preview" src={previewUrl}></iframe>
      {:else if kind === "media"}
        <div class="preview-img">
          {#if ct.startsWith("audio/")}<audio controls src={previewUrl}></audio>{:else}<video controls src={previewUrl}><track kind="captions" /></video>{/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if mountEditor}
    <div class="pane" class:hidden={showingPreview}>
      {#if res.bodySize === 0}
        <div class="empty-state small">The response has no body.</div>
      {:else if !view.doc}
        <div class="empty-state small" role="status"><span class="spinner"></span>Preparing…</div>
      {:else}
        <Editor bind:this={editor} bind:folding bind:canFoldAll doc={view.doc} readonly wrap={wrapped} language={isBinary ? "text" : KIND_INFO[kind].language} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .small {
    font-size: 12px;
  }
  /* Holds a control's tooltip. */
  .tip {
    display: flex;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: var(--bar-pad-y) var(--bar-pad-end) var(--bar-pad-y) var(--bar-pad-start);
    flex: none;
  }
  .filter-row {
    display: flex;
    padding: 0 var(--bar-pad-end) var(--bar-pad-y) var(--bar-pad-start);
    flex: none;
  }
  .folding {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .lang {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--border);
  }
  /* Wrapped, a very long line (BodyView.longLines) breaks at any character, so
     its rows are as full as CodeMirror assumes when it estimates the height of
     what it hasn't drawn. Broken at punctuation instead, a long minified body's
     rows come out a third shorter: the line grows as it's scrolled, and its end
     can't be reached. */
  .body.long-lines :global(.cm-content.cm-lineWrapping) {
    word-break: break-all;
  }
  /* Raw and Preview are stacked in the same place; the hidden one keeps its
     layout (visibility, not display: none), so switching needs no re-layout. */
  .pane {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .pane > :global(*) {
    flex: 1;
    min-height: 0;
  }
  .hidden {
    visibility: hidden;
  }
  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  iframe {
    border: none;
    width: 100%;
    height: 100%;
    background: #fff;
  }
  .preview-img {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
    background: repeating-conic-gradient(var(--panel-2) 0 25%, var(--panel) 0 50%) 0 0 / 16px 16px;
  }
  .preview-img img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
