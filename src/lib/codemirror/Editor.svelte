<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { Compartment, EditorState, Prec, Transaction, type EditorSelection, type Extension, type StateEffect, type Text } from "@codemirror/state";
  import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
  import { openSearchPanel } from "@codemirror/search";
  import { foldEffect, foldedRanges, forceParsing, unfoldAll } from "@codemirror/language";
  import { canFoldAll as canFoldAllOf, foldAllInPieces } from "./foldAll";
  import { editorExtensions, languageExtension, variableExtensions, type Language, type VarProvider } from "./setup";

  interface Props {
    value?: string;
    /**
     * A document built ahead (a large response body), shown instead of
     * `value`. A new one replaces the whole document; nothing is compared or
     * turned back into a string.
     */
    doc?: Text;
    onchange?: (value: string) => void;
    language?: Language;
    readonly?: boolean;
    wrap?: boolean;
    placeholder?: string;
    variables?: VarProvider | null;
    gutters?: boolean;
    /** Runs on Mod-Enter instead of the default (insert a blank line). */
    onsend?: () => void;
    /** Extra extensions, fixed at mount. */
    extensions?: Extension;
    /** Out: whether Fold all is parsing the document before it folds. */
    folding?: boolean;
    /** Out: whether the document is small enough for Fold all (`foldAll.ts`). */
    canFoldAll?: boolean;
  }
  let { value = "", doc, onchange, language = "text", readonly = false, wrap = false, placeholder, variables = null, gutters = true, onsend, extensions = [], folding = $bindable(false), canFoldAll = $bindable(true) }: Props = $props();

  /**
   * The most time spent colouring the visible text when an editor is created:
   * CodeMirror's own per-update parse budget, well inside a frame.
   */
  const PARSE_ON_MOUNT_MS = 20;

  let host: HTMLDivElement;
  let view = $state.raw<EditorView | null>(null);
  const baseC = new Compartment();
  const langC = new Compartment();
  const varC = new Compartment();

  // A prebuilt document goes into a wrapped view only once the view has
  // measured itself without it, so it's laid out like a document replaced in
  // an open editor. Laid out wrapped from scratch (a new view, or wrapping
  // turned on or off), CodeMirror measures a very long line (a 50 MB minified
  // body) with the unwrapped stand-in for its hidden part, takes it to be a
  // short line, and draws all of it, freezing the window for seconds.

  /** What the view holds meanwhile: a line of text, so it measures a real line's height. */
  const STAND_IN = " ";
  /** The view is waiting a frame to put `doc` in. */
  let docPending = false;
  let destroyed = false;

  /**
   * Puts `doc` into `v` (holding the stand-in) after its next measure: the selection,
   * folds and the position at the top of `keep` come back if it's the same document.
   */
  function putDocAfterMeasure(v: EditorView, keep?: { doc: Text; selection: EditorSelection; folds: StateEffect<unknown>[]; top: number }) {
    docPending = true;
    // Runs after CodeMirror's own measure, which it asked a frame for first.
    requestAnimationFrame(() => {
      docPending = false;
      if (destroyed || !doc) return;
      const same = keep?.doc === doc;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: doc },
        selection: same ? keep.selection : undefined,
        effects: same ? [...keep.folds, EditorView.scrollIntoView(keep.top, { y: "start" })] : [],
        annotations: Transaction.addToHistory.of(false),
      });
    });
  }

  /** Applies `effects` (wrapping on or off) to a prebuilt document's view, laying the document out afresh. */
  function relayOut(v: EditorView, effects: StateEffect<unknown>) {
    const { state } = v;
    const folds: StateEffect<unknown>[] = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => void folds.push(foldEffect.of({ from, to })));
    const r = v.scrollDOM.getBoundingClientRect();
    const top = v.posAtCoords({ x: r.left + r.width / 2, y: r.top + 1 }, false);
    const keep = { doc: state.doc, selection: state.selection, folds, top };
    v.dispatch({ changes: { from: 0, to: state.doc.length, insert: STAND_IN }, effects, annotations: Transaction.addToHistory.of(false) });
    putDocAfterMeasure(v, keep);
  }

  onMount(() => {
    const deferDoc = !!doc && wrap;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: deferDoc ? STAND_IN : (doc ?? value),
        extensions: [
          baseC.of(editorExtensions({ readonly, wrap, placeholder, gutters })),
          langC.of(languageExtension(language)),
          varC.of(variables ? variableExtensions(variables) : []),
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (onsend ? (onsend(), true) : false) },
              // Fold all's key (CodeMirror's folds at once): in pieces, and not above the limit.
              { key: "Ctrl-Alt-[", run: () => (fold(true), true) },
            ]),
          ),
          // Also when the whole state is replaced.
          ViewPlugin.define((v) => {
            canFoldAll = canFoldAllOf(v.state.doc.length);
            return { update: (u) => void (u.docChanged && (canFoldAll = canFoldAllOf(u.state.doc.length))) };
          }),
          extensions,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    // A new state parses only its first 3000 characters; the rest of the view
    // would stay uncoloured until CodeMirror's idle-time parse (100 ms or more).
    // Parse what's in view now, before the first paint, so switching back to an
    // editor (Preview → Raw) is coloured at once. Capped so a huge body can't stall.
    forceParsing(view, view.viewport.to, PARSE_ON_MOUNT_MS);
    if (deferDoc) putDocAfterMeasure(view);
  });
  onDestroy(() => {
    destroyed = true;
    view?.destroy();
  });

  $effect(() => {
    const d = doc;
    if (d) {
      if (view && !docPending && d !== view.state.doc) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: d }, annotations: Transaction.addToHistory.of(false) });
      return;
    }
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });
  $effect(() => {
    const l = language;
    view?.dispatch({ effects: langC.reconfigure(languageExtension(l)) });
  });
  /** Whether the view's lines wrap now. */
  let wrapped = untrack(() => wrap);
  $effect(() => {
    const opts = { readonly, wrap, placeholder, gutters };
    if (!view) return;
    const effects = baseC.reconfigure(editorExtensions(opts));
    const rewrap = wrap !== wrapped;
    wrapped = wrap;
    if (rewrap && untrack(() => doc) && !docPending) relayOut(view, effects);
    else view.dispatch({ effects });
  });
  $effect(() => {
    const p = variables;
    view?.dispatch({ effects: varC.reconfigure(p ? variableExtensions(p) : []) });
  });

  export function openSearch() {
    if (view) openSearchPanel(view);
  }
  /** Bumped to drop a Fold all still parsing (Unfold all, or another Fold all). */
  let foldRun = 0;
  /** Fold all (in pieces, showing `folding` meanwhile; nothing above the limit) or Unfold all. */
  export function fold(all: boolean) {
    const v = view;
    if (!v) return;
    const run = ++foldRun;
    if (!all) {
      folding = false;
      unfoldAll(v);
      return;
    }
    if (!canFoldAllOf(v.state.doc.length)) return;
    folding = true;
    void foldAllInPieces(v, () => run !== foldRun).finally(() => {
      if (run === foldRun) folding = false;
    });
  }
  export function focus() {
    view?.focus();
  }
  /** The document as shown (never turned into one string: it may be a large body). */
  export function document(): Text | null {
    return view?.state.doc ?? null;
  }
  /** Selects line `n` (1-based) and scrolls it into view, focusing the editor so the selection shows. */
  export function revealLine(n: number) {
    if (!view || n < 1 || n > view.state.doc.lines) return;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }
  /**
   * For a context menu at `e`: moves the caret to the clicked spot unless the
   * click is inside the selection (which a Copy item then copies), and returns
   * the caret offset. A menu without a position keeps the caret.
   */
  export function caretForMenu(e: MouseEvent): number {
    if (!view) return 0;
    const sel = view.state.selection.main;
    const pos = e.clientX || e.clientY ? view.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
    if (pos === null || (pos >= sel.from && pos <= sel.to && !sel.empty)) return sel.head;
    view.dispatch({ selection: { anchor: pos } });
    return pos;
  }
</script>

<div class="cm-host" bind:this={host}></div>

<style>
  .cm-host {
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
  }
</style>
