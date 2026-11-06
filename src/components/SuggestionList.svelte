<script lang="ts">
  // The list of a `use:suggestions` combobox (lib/popup/suggestions.svelte.ts),
  // mounted into the popup layer while it's open. Styled to look exactly like
  // CodeMirror's {{variable}} autocomplete (`.cm-tooltip-autocomplete` in
  // lib/codemirror/setup.ts); e2e/header-suggestions.spec.ts compares the two.
  import { popup, type CloseReason } from "../lib/popup/popup";
  import type { SuggestionMatch } from "../lib/suggest";

  interface Props {
    id: string;
    label: string;
    anchor: HTMLElement;
    matches: SuggestionMatch[];
    active: number;
    onpick: (i: number) => void;
    onclose: (reason: CloseReason) => void;
  }
  let { id, label, anchor, matches, active, onpick, onclose }: Props = $props();

  let list: HTMLUListElement | undefined = $state();

  $effect(() => {
    list?.children[active]?.scrollIntoView({ block: "nearest" });
  });
</script>

<!-- mousedown keeps focus (and the caret) in the input, so a click can accept. -->
<div class="popup-surface suggestions" role="presentation" onmousedown={(e) => e.preventDefault()} use:popup={{ anchor, onclose }}>
  <ul bind:this={list} {id} role="listbox" aria-label={label}>
    {#each matches as m, i (m.value)}
      <!-- The keyboard stays in the input (arrows, Enter, Tab), like CodeMirror's list. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li id="{id}-{i}" role="option" aria-selected={i === active} onclick={() => onpick(i)}>
        {m.value.slice(0, m.from)}<span class="matched">{m.value.slice(m.from, m.to)}</span>{m.value.slice(m.to)}
      </li>
    {/each}
  </ul>
</div>

<style>
  /* Same numbers as the .cm-tooltip-autocomplete rules (CodeMirror's base theme plus ours). */
  .suggestions {
    overflow: hidden;
  }
  ul {
    margin: 0;
    padding: 4px;
    list-style: none;
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden auto;
    min-width: 250px;
    max-width: min(700px, 95vw);
    max-height: 10em;
  }
  li {
    padding: 2px 6px;
    line-height: 1.2;
    border-radius: 5px;
    overflow-x: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  li[aria-selected="true"] {
    background: var(--accent-soft);
    color: var(--text);
  }
  .matched {
    text-decoration: underline;
  }
</style>
