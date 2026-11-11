<script lang="ts">
  // The editor's find bar (and, in an editable editor, replace), shown as a
  // CodeMirror panel above the text. Built from the app's controls so it looks
  // like the toolbars around it: a FilterField with a search icon, icon
  // buttons, and pressed-state glyph toggles instead of native checkboxes.
  // findPanel.svelte.ts mounts it and owns the link to CodeMirror.
  import { SearchQuery } from "@codemirror/search";
  import FilterField from "../../components/FilterField.svelte";
  import Icon from "../../components/Icon.svelte";
  import { tooltip } from "../popup/tooltip.svelte";
  import type { FindActions, FindQuery } from "./findPanel.svelte";

  interface Props {
    /** The query; the bar edits it in place and calls `actions.commit()`. */
    query: FindQuery;
    /** Read-only editors (a response body) get no replace row. */
    readonly: boolean;
    actions: FindActions;
    /** A find next or previous is still working through a large document. */
    searching: boolean;
  }

  let { query, readonly, actions, searching }: Props = $props();
  const id = $props.id();
  let root: HTMLDivElement | undefined;

  /** The Find text field (the panel focuses it on open and on ⌘F / Ctrl+F). */
  export function findField(): HTMLInputElement | null {
    return root?.querySelector("input") ?? null;
  }

  // An empty field isn't an error, only a pattern that doesn't compile is.
  const invalid = $derived(query.search !== "" && !new SearchQuery(query).valid);

  type Toggle = "caseSensitive" | "regexp" | "wholeWord";
  const toggles: { key: Toggle; label: string; glyph: string }[] = [
    { key: "caseSensitive", label: "Match case", glyph: "Aa" },
    { key: "regexp", label: "Regular expression", glyph: ".*" },
    { key: "wholeWord", label: "Whole word", glyph: "ab" },
  ];

  /** Changes one field of the query and pushes the query to the editor. */
  function commitField<K extends keyof FindQuery>(key: K, value: FindQuery[K]) {
    query[key] = value;
    actions.commit();
  }

  function findKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) actions.previous();
    else actions.next();
  }

  function replaceKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    actions.replaceNext();
  }
</script>

<div class="find" role="search" aria-label="Find in editor" bind:this={root}>
  <FilterField
    icon="search"
    label="Find"
    placeholder="Find"
    value={query.search}
    {invalid}
    describedby={invalid ? `${id}-error` : undefined}
    oninput={(v) => commitField("search", v)}
    onkeydown={findKey}
  />
  <span class="controls">
    {#if searching}<span class="status" role="status">Searching…</span>{/if}
    <span class="group">
      {#each toggles as t (t.key)}
        <button
          class="icon-btn glyph"
          class:active={query[t.key]}
          aria-label={t.label}
          aria-pressed={query[t.key]}
          use:tooltip
          onclick={() => commitField(t.key, !query[t.key])}>{#if t.key === "wholeWord"}<u>{t.glyph}</u>{:else}{t.glyph}{/if}</button
        >
      {/each}
    </span>
    <span class="group">
      <button class="icon-btn" aria-label="Previous match" use:tooltip={"Previous match (Shift Enter)"} onclick={() => actions.previous()}
        ><Icon name="chevron-up" size={14} /></button
      >
      <button class="icon-btn" aria-label="Next match" use:tooltip={"Next match (Enter)"} onclick={() => actions.next()}
        ><Icon name="chevron-down" size={14} /></button
      >
      <button class="icon-btn" aria-label="Close find" use:tooltip={"Close (Esc)"} onclick={() => actions.close()}><Icon name="x" size={14} /></button>
    </span>
  </span>
  {#if invalid}<div class="error" id="{id}-error" role="alert">Not a valid regular expression</div>{/if}
  {#if !readonly}
    <input
      class="input small"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="Replace"
      aria-label="Replace"
      value={query.replace}
      oninput={(e) => commitField("replace", e.currentTarget.value)}
      onkeydown={replaceKey}
    />
    <span class="controls">
      <button class="btn small" onclick={() => actions.replaceNext()}>Replace</button>
      <button class="btn small" onclick={() => actions.replaceAll()}>Replace all</button>
    </span>
  {/if}
</div>

<style>
  /* The same inset as the Body toolbar above the editor (the --bar-pad tokens).
     Two columns, so the Find and Replace fields share one width and the
     controls line up. */
  .find {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--bar-pad-y) var(--space-2);
    padding: var(--bar-pad-y) var(--bar-pad-end) var(--bar-pad-y) var(--bar-pad-start);
    font-family: var(--font);
    font-size: 12px;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .status {
    color: var(--muted);
    white-space: nowrap;
  }
  .error {
    grid-column: 1 / -1;
    color: var(--danger);
    font-size: 11.5px;
  }
</style>
