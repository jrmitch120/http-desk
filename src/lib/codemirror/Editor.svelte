<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { openSearchPanel } from "@codemirror/search";
  import { foldAll, unfoldAll } from "@codemirror/language";
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
