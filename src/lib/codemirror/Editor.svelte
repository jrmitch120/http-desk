<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { Annotation, Compartment, EditorState, Prec, Transaction, type EditorSelection, type Extension, type StateEffect, type Text } from "@codemirror/state";
  import { history } from "@codemirror/commands";
  import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
  import { openSearchPanel } from "@codemirror/search";
  import { foldEffect, foldedRanges, forceParsing, syntaxTree, unfoldAll } from "@codemirror/language";
  import { canFoldAll as canFoldAllOf, foldAllInPieces } from "./foldAll";
  import { editorExtensions, languageExtension, variableExtensions, type Language, type VarProvider } from "./setup";
  import { setUnderlines, underlines as underlineExtension, type Underline } from "./underlines";
  import { lineMarks, setLineMarks, type LineMark } from "./lineMarks";
  import { inReadOnlyRegion } from "./readOnly";
  import { keepLineEndings, readEndings, setEndings, textWithEndings, type LineBreak } from "./lineEndings";
  import { sharedEnds } from "../splice";
  import { editorKey } from "../platform";

  interface Props {
    value?: string;
    /**
     * A document built ahead (a large response body), shown instead of
     * `value`. A new one replaces the whole document; nothing is compared or
     * turned back into a string.
     */
    doc?: Text;
    /** The user changed the text (never for a new `value`). */
    onchange?: (value: string) => void;
    /**
     * A new `value` starts a new undo history, so undo can't take back what came
     * from outside (the Source view: an edit in the structured editors clears it).
     */
    freshHistory?: boolean;
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
    /** Wavy underlines with a message on hover (`underlines.ts`), at offsets into `value`. Only for an editor given them at mount. */
    underlines?: Underline[];
    /** Markers in a gutter of their own, with hovers (`lineMarks.ts`). Given at mount, the gutter is there and follows this. */
    lineMarks?: LineMark[];
    /**
     * For the text of a file with mixed line endings: `value` keeps each line's own
     * (`\r\n` or `\n`), so does `onchange`'s text, and a line break typed anew is this,
     * the file's own (lineEndings.ts). Without it the text's breaks are all `\n`.
     */
    lineBreak?: LineBreak;
  }
  let { value = "", doc, onchange, freshHistory = false, language = "text", readonly = false, wrap = false, placeholder, variables = null, gutters = true, onsend, extensions = [], folding = $bindable(false), canFoldAll = $bindable(true), underlines, lineMarks: marks, lineBreak }: Props = $props();

  /** `v`'s text, as `value` is given and `onchange` gives it. */
  const textOf = (state: EditorState) => (lineBreak ? textWithEndings(state, lineBreak) : state.doc.toString());

  /**
   * The most time spent colouring the visible text when an editor is created
   * or given a new document: CodeMirror's own per-update parse budget, well
   * inside a frame.
   */
  const PARSE_ON_MOUNT_MS = 20;

  /**
   * How far past what's parsed the text drawn may end for parseDrawn to try:
   * a little under what CodeMirror's JSON parser gets through in
   * PARSE_ON_MOUNT_MS on an M1 Pro (measured on #58: 170,000 characters of
   * Pretty text, 230,000 minified; CI's runners are about half as fast).
   */
  const PARSE_REACH = 160_000;

  /**
   * Parses `v`'s new document up to the end of the text drawn, for at most
   * PARSE_ON_MOUNT_MS, so it's coloured on the first frame. A new state parses
   * only its first 3000 characters; the rest would stay uncoloured until
   * CodeMirror's idle-time parse (100 ms or more). Up to the end of the text
   * drawn, not of the viewport: the viewport takes in the whole of a long line
   * (a 50 MB minified body) though only part of it is drawn. Nothing when the
   * text drawn is parsed already, or ends too far on to reach in time: handing
   * the new tree to the view costs CodeMirror another parse of up to 20 ms
   * toward the viewport's end, which on that line is 50 MB away.
   */
  function parseDrawn(v: EditorView) {
    const drawnTo = v.visibleRanges.at(-1)?.to ?? v.viewport.to;
    const parsed = syntaxTree(v.state).length;
    if (drawnTo > parsed && drawnTo - parsed <= PARSE_REACH) forceParsing(v, drawnTo, PARSE_ON_MOUNT_MS);
  }

  let host: HTMLDivElement;
  let view = $state.raw<EditorView | null>(null);
  const baseC = new Compartment();
  const langC = new Compartment();
  const varC = new Compartment();
  /** The undo history, with `freshHistory` (otherwise it's in baseC's extensions). */
  const histC = new Compartment();
  /**
   * Read-only while in a read-only region (readOnly.ts): the text can't be changed, but
   * unlike `readonly` the editor keeps its undo history (undo is refused meanwhile), so
   * it's all there once the region can be edited again.
   */
  const lockC = new Compartment();
  const readOnlyHere = inReadOnlyRegion();
  const lockExt = (on: boolean) => (on ? EditorState.readOnly.of(true) : []);
  const ownHistory = untrack(() => freshHistory);
  const historyExt = (ro: boolean) => (ownHistory && !ro ? history() : []);
  const baseExt = (opts: { readonly: boolean; wrap: boolean; placeholder?: string; gutters?: boolean }) =>
    editorExtensions({ ...opts, history: !ownHistory });
  /** Marks a change that puts a new `value` in: not the user's, so no `onchange`. */
  const fromValue = Annotation.define<boolean>();
  /** The text `onchange` was last given, and the document it was. */
  let emitted: { doc: Text; text: string } | null = null;

  /**
   * Puts `text` in place of `v`'s, changing only the span that differs, so a
   * selection outside it stays where it was. With `freshHistory`, the undo
   * history starts again (taking the history out and putting it back). Each line
   * takes its ending from `value` (`lineBreak`).
   */
  function setValue(v: EditorView, value: string) {
    const br = untrack(() => lineBreak);
    const { doc: text, others } = br ? readEndings(value, br) : { doc: value, others: [] };
    const old = v.state.doc.toString();
    const { head: from, tail: end } = sharedEnds(old.length, text.length, (i, j) => old.charCodeAt(i) === text.charCodeAt(j));
    const change = v.state.update({
      changes: { from, to: old.length - end, insert: text.slice(from, text.length - end) },
      effects: setEndings.of(others),
      annotations: fromValue.of(true),
    });
    if (!ownHistory || untrack(() => readonly)) return v.dispatch(change);
    const forget = change.state.update({ effects: histC.reconfigure([]), annotations: fromValue.of(true) });
    v.dispatch([change, forget, forget.state.update({ effects: histC.reconfigure(historyExt(false)), annotations: fromValue.of(true) })]);
  }

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
   * Puts `d` (a prebuilt document, or the stand-in) in place of `v`'s whole
   * document, parsing it as a new editor would: only its start at once (and
   * then, unless `after` moves elsewhere, the text drawn), the rest in the
   * background. `after` (a selection, effects) applies to the new document.
   *
   * Replaced in a plain transaction, the new text would be parsed toward its
   * end for CodeMirror's full per-update budget (20 ms), as the old viewport's
   * end maps to the new document's end, and the old document's unfinished
   * background parse would first have its tree built, which takes tens of
   * milliseconds after several MB. Taking the language out with the old text
   * and putting it back in the same update starts afresh instead.
   */
  function putDoc(v: EditorView, d: Text | string, after?: { selection?: EditorSelection; effects: StateEffect<unknown>[] }) {
    const notInHistory = Transaction.addToHistory.of(false);
    const swap = v.state.update({ changes: { from: 0, to: v.state.doc.length, insert: d }, effects: langC.reconfigure([]), annotations: notInHistory });
    const reparse = langC.reconfigure(languageExtension(untrack(() => language)));
    v.dispatch([swap, swap.state.update({ selection: after?.selection, effects: [reparse, ...(after?.effects ?? [])], annotations: notInHistory })]);
    // What's drawn before the next measure isn't what will show if `after` scrolls or rewraps.
    if (!after) parseDrawn(v);
  }

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
      if (keep?.doc !== doc) {
        putDoc(v, doc);
        return;
      }
      putDoc(v, doc, { selection: keep.selection, effects: keep.folds });
      // In its own update: CodeMirror clips a scroll target to the document as
      // it was before the update, which in putDoc's is the one-character
      // stand-in. Back at the top, with no margin (so the line above doesn't
      // show and become the top for the next rewrap), and in the middle across,
      // where it was taken from (a long line unwrapped scrolls across to it).
      v.dispatch({ effects: EditorView.scrollIntoView(keep.top, { y: "start", yMargin: 0, x: "center" }) });
    });
  }

  /** Applies `effects` (wrapping on or off) to a prebuilt document's view, laying the document out afresh. */
  function relayOut(v: EditorView, effects: StateEffect<unknown>) {
    const { state } = v;
    const folds: StateEffect<unknown>[] = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => void folds.push(foldEffect.of({ from, to })));
    const r = v.scrollDOM.getBoundingClientRect();
    const top = v.posAtCoords({ x: r.left + r.width / 2, y: r.top + 1 }, false);
    // The `doc` the view holds, not `state.doc`: putting a document in copies it.
    const keep = { doc: untrack(() => doc)!, selection: state.selection, folds, top };
    putDoc(v, STAND_IN, { effects: [effects] });
    putDocAfterMeasure(v, keep);
  }

  onMount(() => {
    const deferDoc = !!doc && wrap;
    const initial = lineBreak ? readEndings(value, lineBreak) : { doc: value, others: [] };
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: deferDoc ? STAND_IN : (doc ?? initial.doc),
        extensions: [
          baseC.of(baseExt({ readonly, wrap, placeholder, gutters })),
          histC.of(historyExt(readonly)),
          lockC.of(lockExt(readOnlyHere())),
          langC.of(languageExtension(language)),
          varC.of(variables ? variableExtensions(variables) : []),
          Prec.highest(
            keymap.of([
              // ⌘Enter / Ctrl+Enter, as Send is on the app's OS (platform.ts), not CodeMirror's `Mod-`.
              { key: editorKey({ mod: true, key: "Enter" }), run: () => (onsend ? (onsend(), true) : false) },
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
          untrack(() => underlines) ? underlineExtension() : [],
          untrack(() => marks) ? lineMarks() : [],
          keepLineEndings(initial.others),
          EditorView.updateListener.of((u) => {
            // Without an `onchange` there's no text to make: a response body may be 88 MB.
            if (!onchange || !u.transactions.some((tr) => tr.docChanged && !tr.annotation(fromValue))) return;
            const text = textOf(u.state);
            emitted = { doc: u.state.doc, text };
            onchange?.(text);
          }),
        ],
      }),
    });
    // Before the first paint, so switching back to an editor (Preview → Raw)
    // is coloured at once.
    parseDrawn(view);
    if (deferDoc) putDocAfterMeasure(view);
  });
  onDestroy(() => {
    destroyed = true;
    view?.destroy();
  });

  $effect(() => {
    const on = readOnlyHere();
    view?.dispatch({ effects: lockC.reconfigure(lockExt(on)) });
  });
  $effect(() => {
    const d = doc;
    if (d) {
      if (view && !docPending && d !== view.state.doc) putDoc(view, d);
      return;
    }
    const v = value;
    // The text just typed, given back: the document already holds it (a large file's text isn't made again).
    if (view && !(emitted?.doc === view.state.doc && emitted.text === v) && v !== textOf(view.state)) setValue(view, v);
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
    const effects = baseC.reconfigure(baseExt(opts));
    // The same history kept (its state goes on), or none while read-only.
    const hist = histC.reconfigure(historyExt(readonly));
    const rewrap = wrap !== wrapped;
    wrapped = wrap;
    if (rewrap && untrack(() => doc) && !docPending) {
      relayOut(view, effects);
      view.dispatch({ effects: hist });
    } else view.dispatch({ effects: [effects, hist] });
  });
  $effect(() => {
    // After the document effect above, so they're placed in the text they were found in.
    const u = underlines;
    if (u) view?.dispatch({ effects: setUnderlines.of(u) });
  });
  $effect(() => {
    const p = variables;
    view?.dispatch({ effects: varC.reconfigure(p ? variableExtensions(p) : []) });
  });
  $effect(() => {
    const m = marks;
    if (m) view?.dispatch({ effects: setLineMarks.of(m) });
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
  /** Puts the caret at offset `pos` and scrolls its line to the top of the view; with `focus`, focuses the editor too. */
  export function revealAt(pos: number, { focus = false } = {}) {
    if (!view || pos < 0 || pos > view.state.doc.length) return;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }) });
    if (focus) view.focus();
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
