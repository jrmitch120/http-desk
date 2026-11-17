<!--
  Compare (`app.history.comparison`): two responses side by side in CodeMirror's merge
  view, the older on the left. Body and Headers each diff as compare.ts lays them out
  (JSON with its keys sorted, so key order and spacing don't show). Closing it releases
  the entries opened for it (HistoryStore.closeComparison).
-->
<script lang="ts">
  import { MergeView } from "@codemirror/merge";
  import { app } from "../lib/store.svelte";
  import type { Comparison } from "../lib/history.svelte";
  import { bodyText, compareLanguage, headersText } from "../lib/compare";
  import { editorExtensions, languageExtension, type Language } from "../lib/codemirror/setup";
  import Modal from "./Modal.svelte";
  import Banner from "./Banner.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";

  let { comparison }: { comparison: Comparison } = $props();

  type Part = "body" | "headers";
  let part = $state<Part>("body");
  let bodies = $state<[string, string] | null>(null);

  $effect(() => {
    const { a, b } = comparison;
    let current = true;
    Promise.all([bodyText(a), bodyText(b)]).then((texts) => current && (bodies = texts));
    return () => (current = false);
  });

  const texts = $derived<[string, string] | null>(
    part === "body" ? bodies : [headersText(comparison.a), headersText(comparison.b)],
  );
  const language = $derived<Language>(part === "body" ? compareLanguage(comparison.a, comparison.b) : "text");

  let host: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!host || !texts) return;
    const extensions = (lang: Language) => [editorExtensions({ readonly: true, wrap: part === "headers" }), languageExtension(lang)];
    const view = new MergeView({
      a: { doc: texts[0], extensions: extensions(language) },
      b: { doc: texts[1], extensions: extensions(language) },
      parent: host,
      gutter: true,
      // Long unchanged stretches fold away, unless nothing changed: then it's all there to read.
      ...(texts[0] === texts[1] ? {} : { collapseUnchanged: { margin: 3, minSize: 4 } }),
    });
    return () => view.destroy();
  });
</script>

<Modal title="Compare" onclose={() => app.history.closeComparison()} width="min(1100px, calc(100vw - 48px))" height="min(760px, calc(100vh - 48px))">
  <div class="compare">
    <div class="bar">
      <SegmentedControl label="Compare" options={[{ value: "body", label: "Body" }, { value: "headers", label: "Headers" }]} value={part} onchange={(p) => (part = p)} />
      <span class="about muted">{comparison.a.label} vs. {comparison.b.label}</span>
    </div>
    {#if texts && texts[0] === texts[1]}
      <Banner severity="info">{part === "body" ? "The bodies are the same" : "The headers are the same"}</Banner>
    {/if}
    <div class="sides muted">
      <span>{comparison.a.label}</span>
      <span>{comparison.b.label}</span>
    </div>
    <div class="merge" bind:this={host}></div>
  </div>
</Modal>

<style>
  .compare {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .about {
    font-size: 12px;
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    font-size: 12px;
    padding: 4px 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .merge {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .merge :global(.cm-mergeView) {
    min-height: 100%;
  }
  .merge :global(.cm-changedLine),
  .merge :global(.cm-deletedChunk) {
    background: color-mix(in srgb, var(--warning, #d29922) 14%, transparent);
  }
  .merge :global(.cm-merge-a .cm-changedLine) {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .merge :global(.cm-merge-b .cm-changedLine) {
    background: color-mix(in srgb, var(--success, #3fb950) 14%, transparent);
  }
  .merge :global(.cm-collapsedLines) {
    background: var(--hover);
    color: var(--muted);
    font-size: 11.5px;
  }
  .merge :global(.cm-changedText) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
</style>
