<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { openSearchPanel } from "@codemirror/search";
  import { foldAll, forceParsing, unfoldAll } from "@codemirror/language";
  import { editorExtensions, languageExtension, variableExtensions, type Language, type VarProvider } from "./setup";

  interface Props {
    value: string;
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
  }
  let { value, onchange, language = "text", readonly = false, wrap = false, placeholder, variables = null, gutters = true, onsend, extensions = [] }: Props = $props();

  /** The most time spent colouring the visible text when an editor is created. */
  const PARSE_ON_MOUNT_MS = 50;

  let host: HTMLDivElement;
  let view = $state.raw<EditorView | null>(null);
  const baseC = new Compartment();
  const langC = new Compartment();
  const varC = new Compartment();

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          baseC.of(editorExtensions({ readonly, wrap, placeholder, gutters })),
          langC.of(languageExtension(language)),
          varC.of(variables ? variableExtensions(variables) : []),
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (onsend ? (onsend(), true) : false) }])),
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
  });
  onDestroy(() => view?.destroy());

  $effect(() => {
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });
  $effect(() => {
    const l = language;
    view?.dispatch({ effects: langC.reconfigure(languageExtension(l)) });
  });
  $effect(() => {
    const opts = { readonly, wrap, placeholder, gutters };
    view?.dispatch({ effects: baseC.reconfigure(editorExtensions(opts)) });
  });
  $effect(() => {
    const p = variables;
    view?.dispatch({ effects: varC.reconfigure(p ? variableExtensions(p) : []) });
  });

  export function openSearch() {
    if (view) openSearchPanel(view);
  }
  export function fold(all: boolean) {
    if (view) (all ? foldAll : unfoldAll)(view);
  }
  export function focus() {
    view?.focus();
  }
  /** The document's text as shown. */
  export function text(): string {
    return view?.state.doc.toString() ?? "";
  }
  /** The selected text (the main selection), or "" if nothing is selected. */
  export function selectedText(): string {
    if (!view) return "";
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  }
  export function selectAll() {
    view?.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  }
  /** Opens the context menu at the caret, for Shift+F10 (dispatches `contextmenu` on the content). */
  export function openMenuAtCaret() {
    if (!view) return;
    const at = view.coordsAtPos(view.state.selection.main.head);
    const x = at ? at.left : 0;
    const y = at ? (at.top + at.bottom) / 2 : 0;
    view.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
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
