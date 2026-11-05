<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState } from "@codemirror/state";
  import { drawSelection, EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { completionKeymap } from "@codemirror/autocomplete";
  import { theme, variableExtensions, type VarProvider } from "./setup";

  interface Props {
    value: string;
    onchange: (value: string) => void;
    onenter?: () => void;
    placeholder?: string;
    variables?: VarProvider | null;
  }
  let { value, onchange, onenter, placeholder = "", variables = null }: Props = $props();

  let host: HTMLDivElement;
  let view = $state.raw<EditorView | null>(null);
  const varC = new Compartment();

  // Single line: strip newlines from any edit (including paste).
  const singleLine = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
    const text = tr.newDoc.toString().replace(/\s*\n\s*/g, "");
    return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: text }, sequential: true }];
  });

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          theme,
          EditorView.theme({
            "&": { fontSize: "13px", height: "100%" },
            // Scrolls horizontally (wheel, trackpad, caret, drag-select) without a visible scrollbar.
            ".cm-scroller": { overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", lineHeight: "30px", fontFamily: "var(--mono)" },
            ".cm-scroller::-webkit-scrollbar": { display: "none" },
            ".cm-content": { padding: "0", lineHeight: "30px" },
            ".cm-line": { padding: "0 10px", lineHeight: "30px" },
            ".cm-activeLine": { backgroundColor: "transparent" },
          }),
          singleLine,
          history(),
          drawSelection(),
          placeholderExt(placeholder),
          keymap.of([
            { key: "Enter", run: () => (onenter?.(), true) },
            { key: "Mod-Enter", run: () => (onenter?.(), true) },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          varC.of(variables ? variableExtensions(variables) : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString());
            // While typing, the text is the user's; resync to the model on blur.
            if (u.focusChanged && !u.view.hasFocus) sync();
          }),
        ],
      }),
    });
  });
  onDestroy(() => view?.destroy());

  function sync() {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }
  $effect(() => {
    void value;
    if (view && !view.hasFocus) sync();
  });
  $effect(() => {
    const p = variables;
    view?.dispatch({ effects: varC.reconfigure(p ? variableExtensions(p) : []) });
  });

  export function focus() {
    view?.focus();
  }
</script>

<div class="url-input" bind:this={host}></div>

<style>
  .url-input {
    flex: 1;
    min-width: 0;
    height: 32px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-left: none;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .url-input:focus-within {
    border-color: var(--focus);
    border-left: 1px solid var(--focus);
    margin-left: -1px;
  }
  .url-input :global(.cm-editor) {
    height: 100%;
  }
</style>
