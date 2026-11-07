<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Annotation, Compartment, EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { singleLineExtensions, theme, variableExtensions, type VarProvider } from "./setup";

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
  /** Marks a change that puts the model's value in the editor, which isn't an edit to report back. */
  const fromModel = Annotation.define<boolean>();

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
          singleLineExtensions({ placeholder, onenter: () => onenter?.() }),
          varC.of(variables ? variableExtensions(variables) : []),
          EditorView.updateListener.of((u) => {
            // Reporting the model's own value back would re-parse the query params into new
            // row objects, remounting the Params grid's rows under a cell being typed in.
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromModel))) onchange(u.state.doc.toString());
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
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: fromModel.of(true) });
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
