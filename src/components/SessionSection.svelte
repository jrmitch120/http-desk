<!--
  One section of the Session panel: a heading with how many items the Session
  holds, a button clearing just this section, and the section's own content.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    /** How many items the section holds; null while it's still being read. */
    count: number | null;
    /** The Clear button's label ("Clear cookies"). */
    clearLabel: string;
    onclear: () => void;
    children: Snippet;
  }

  let { title, count, clearLabel, onclear, children }: Props = $props();
  const id = $props.id();
</script>

<section class="section" aria-labelledby="{id}-title">
  <div class="head">
    <h3 id="{id}-title">{title}{#if count}<span class="count">{count}</span>{/if}</h3>
    <button class="btn small ghost" disabled={!count} onclick={onclear}>{clearLabel}</button>
  </div>
  {@render children()}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 0 16px;
  }
  h3 {
    flex: 1;
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .count {
    margin-left: 6px;
    font-weight: 500;
    color: var(--muted);
  }
</style>
