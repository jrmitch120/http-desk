<!--
  The response viewer's Body tab: the view switch (Pretty/Raw, Hex, Preview),
  search, folding and wrap, the JSONPath filter bar, and the body itself
  (an editor, or a preview). JSON bodies get their own context menu with
  Copy path. The state behind it (rendered text, filter, shape) is the
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
  import { keymap } from "@codemirror/view";
  import { menu } from "../lib/menu.svelte";
  import { pathAt } from "../lib/jsonpath";
  import type { HttpResponse } from "../lib/types";

  interface Props {
    res: HttpResponse;
    view: BodyView;
    mode: BodyMode;
    wrap: boolean;
    filter: string;
  }
  let { res, view, mode = $bindable(), wrap = $bindable(), filter = $bindable() }: Props = $props();

  let editor: Editor | undefined = $state();

  const kind = $derived(view.kind);
  const isBinary = $derived(view.isBinary);
  const effectiveMode = $derived(view.effectiveMode);
  const filtered = $derived(view.filtered);
  const dataUrl = $derived(view.dataUrl);
  const ct = $derived((res.contentType ?? "").toLowerCase());

  // Raw and Preview stay mounted once shown and are switched by hiding one, so
  // going back to Raw doesn't rebuild the editor (it keeps its scroll, find bar
  // and colouring) and going back to Preview doesn't reload the page. The preview
  // mounts the first time it's opened for a response. Audio and video unmount
  // when hidden, so they stop playing.
  const previewable = $derived(kind === "html" || !!dataUrl);
  const showingPreview = $derived(effectiveMode === "preview" && previewable);
  let previewShownFor = $state<string | null>(null);
  $effect(() => {
    if (showingPreview) previewShownFor = res.id;
  });
  const mountPreview = $derived(showingPreview || (previewShownFor === res.id && previewable && view.canPreview && kind !== "media"));

  const viewOptions = $derived<SegmentedOption<BodyMode>[]>([
    ...(view.canPretty && !isBinary ? [{ value: "pretty" as const, label: "Pretty" }] : []),
    { value: "raw", label: isBinary ? "Hex" : "Raw" },
    ...(view.canPreview ? [{ value: "preview" as const, label: "Preview" }] : []),
  ]);

  // "Copy path" in the body editor's context menu (JSON bodies only; other
  // bodies keep the webview's own menu). Paths are of the text on screen, so
  // not while filter matches show.
  const jsonBody = $derived(kind === "json" && !isBinary);
  function bodyMenu(e: MouseEvent) {
    if (!jsonBody || !editor || !(e.target as HTMLElement).closest?.(".cm-editor")) return;
    const ed = editor;
    const offset = ed.caretForMenu(e);
    const selection = ed.selectedText();
    menu.show(
      e,
      [
        { label: "Copy", icon: "copy", disabled: !selection, action: () => void copyText(selection, "Copied") },
        { label: "Select all", action: () => ed.selectAll() },
        { separator: true },
        { label: "Copy path", icon: "code", disabled: !!filtered, action: () => copyPath(ed.text(), offset) },
      ],
      { label: "Body" },
    );
  }
  async function copyText(text: string, message: string) {
    await navigator.clipboard.writeText(text);
    app.toast("success", message);
  }
  function copyPath(text: string, offset: number) {
    const path = pathAt(text, offset);
    if (path === null) app.toast("error", "There's no JSON value at the cursor");
    else void copyText(path, `Copied ${path}`);
  }
  /** Shift+F10 in the body editor opens the same menu at the caret. */
  const bodyKeys = keymap.of([{ key: "Shift-F10", run: () => (jsonBody ? (editor?.openMenuAtCaret(), true) : false) }]);
</script>

<div class="toolbar">
  <!-- Filter matches are always pretty-printed, so the view is fixed while they show. -->
  <!-- A single view (plain text: Raw only) needs no switch. -->
  {#if viewOptions.length > 1}
    <span class="tip" use:tooltip={filtered ? "Filter matches are always pretty-printed" : ""}>
      <SegmentedControl label="Response view" options={viewOptions} value={filtered ? "pretty" : effectiveMode} disabled={!!filtered} onchange={(m) => (mode = m)} />
    </span>
  {/if}
  {#if !isBinary}<span class="lang muted">{kind.toUpperCase()}</span>{/if}
  <span class="spacer"></span>
  {#if effectiveMode !== "preview"}
    <button class="icon-btn" aria-label="Search" use:tooltip={"Search (⌘/Ctrl F)"} onclick={() => editor?.openSearch()}><Icon name="search" size={14} /></button>
    {#if kind === "json" || kind === "xml"}
      <button class="icon-btn" aria-label="Fold all" use:tooltip onclick={() => editor?.fold(true)}><Icon name="fold" size={14} /></button>
      <button class="icon-btn" aria-label="Unfold all" use:tooltip onclick={() => editor?.fold(false)}><Icon name="unfold" size={14} /></button>
    {/if}
    <button class="icon-btn" class:active={wrap} aria-label="Wrap lines" use:tooltip onclick={() => (wrap = !wrap)}><Icon name="wrap" size={14} /></button>
  {/if}
</div>
{#if view.canFilter}
  <div class="filter-row">
    <ResponseFilter value={filter} onchange={(v) => (filter = v)} matches={filtered?.matches ?? null} error={view.filterError} shape={view.shape} needshape={() => view.loadShape()} />
  </div>
{/if}
<!-- The body editor's context menu (Copy path); other content keeps the webview's. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="body" oncontextmenu={bodyMenu}>
  {#if mountPreview}
    <div class="pane" class:hidden={!showingPreview}>
      {#if kind === "html"}
        <iframe title="HTML preview" sandbox="" srcdoc={res.bodyText ?? ""}></iframe>
      {:else if kind === "image"}
        <div class="preview-img"><img src={dataUrl} alt="Response preview" /></div>
      {:else if kind === "pdf"}
        <iframe title="PDF preview" src={dataUrl}></iframe>
      {:else if kind === "media"}
        <div class="preview-img">
          {#if ct.startsWith("audio/")}<audio controls src={dataUrl}></audio>{:else}<video controls src={dataUrl}><track kind="captions" /></video>{/if}
        </div>
      {/if}
    </div>
  {/if}
  <div class="pane" class:hidden={showingPreview}>
    {#if res.bodySize === 0}
      <div class="empty-state small">The response has no body.</div>
    {:else if view.formatting}
      <div class="empty-state small" role="status"><span class="spinner"></span>Formatting…</div>
    {:else}
      <Editor bind:this={editor} value={view.text} readonly {wrap} language={isBinary ? "text" : KIND_INFO[kind].language} extensions={bodyKeys} />
    {/if}
  </div>
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
    padding: 6px 10px 6px 16px;
    flex: none;
  }
  .filter-row {
    display: flex;
    padding: 0 10px 6px 16px;
    flex: none;
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
