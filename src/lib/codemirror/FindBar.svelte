<script lang="ts">
  // The editor's find bar (and, in an editable editor, replace), shown as a
  // CodeMirror panel above the text. Built from the app's controls so it looks
  // like the toolbars around it: a FilterField with a search icon, icon
  // buttons, and pressed-state toggles instead of native checkboxes.
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
  }

  let { query, readonly, actions }: Props = $props();

  // An empty field isn't an error, only a pattern that doesn't compile is.
  const invalid = $derived(query.search !== "" && !new SearchQuery(query).valid);

  type Toggle = "caseSensitive" | "regexp" | "wholeWord";
  const toggles: { key: Toggle; label: string; glyph: string }[] = [
    { key: "caseSensitive", label: "Match case", glyph: "Aa" },
    { key: "regexp", label: "Regular expression", glyph: ".*" },
    { key: "wholeWord", label: "Whole word", glyph: "ab" },
  ];

  function set<K extends keyof FindQuery>(key: K, value: FindQuery[K]) {
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

<div class="find" role="search" aria-label="Find in editor">
  <FilterField icon="search" label="Find" placeholder="Find" value={query.search} {invalid} oninput={(v) => set("search", v)} onkeydown={findKey} />
  <span class="controls">
    <span class="group">
      {#each toggles as t (t.key)}
        <button
          class="icon-btn glyph"
          class:active={query[t.key]}
          class:word={t.key === "wholeWord"}
          aria-label={t.label}
          aria-pressed={query[t.key]}
          use:tooltip
          onclick={() => set(t.key, !query[t.key])}>{t.glyph}</button
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
  {#if !readonly}
    <input
        class="input replace"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Replace"
        aria-label="Replace"
        value={query.replace}
        oninput={(e) => set("replace", e.currentTarget.value)}
      onkeydown={replaceKey}
    />
    <span class="controls">
      <button class="btn small" onclick={() => actions.replaceNext()}>Replace</button>
      <button class="btn small" onclick={() => actions.replaceAll()}>Replace all</button>
    </span>
  {/if}
</div>

<style>
  /* The same inset and gaps as the Body toolbar above the editor. Two columns,
     so the Find and Replace fields share one width and the controls line up. */
  .find {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px var(--space-2);
    padding: 6px 10px 6px 16px;
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
    gap: 2px;
  }
  .glyph {
    font-family: var(--mono);
    font-size: 12px;
  }
  .glyph.word {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .replace {
    min-width: 0;
    height: var(--control-h-sm);
  }
</style>
