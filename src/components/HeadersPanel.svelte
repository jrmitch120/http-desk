<!--
  The response viewer's Headers tab: a name filter, click-to-copy values,
  Copy all, and hover explanations of well-known caching, CORS and rate-limit
  headers (src/lib/headers.ts).
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { explainHeader, filterHeaders, headersText, type Header } from "../lib/headers";
  import { copyable } from "../lib/copyable";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import FilterField from "./FilterField.svelte";

  let { headers }: { headers: Header[] } = $props();

  let filter = $state("");
  const shown = $derived(filterHeaders(headers, filter));

  /** Always every header, not just the filtered ones: "all" means all, for pasting into a bug report. */
  async function copyAll() {
    await navigator.clipboard.writeText(headersText(headers));
    app.toast("success", "Headers copied");
  }
</script>

<div class="toolbar">
  <div class="filter">
    <FilterField value={filter} oninput={(v) => (filter = v)} label="Filter headers" placeholder="Filter headers" />
  </div>
  {#if filter.trim()}<span class="muted count">{shown.length} of {headers.length}</span>{/if}
  <span class="spacer"></span>
  <button class="btn small ghost" aria-label="Copy all headers" use:tooltip={"Copy all headers as Name: value lines"} disabled={!headers.length} onclick={copyAll}>
    <Icon name="copy" size={13} />Copy all
  </button>
</div>
<div class="data-table">
  {#if shown.length}
    <table aria-label="Response headers">
      <tbody>
        {#each shown as [k, v], i (i)}
          {@const info = explainHeader(k)}
          <tr>
            <td class="k">
              {#if info}<span class="known" use:tooltip={`${info.group}: ${info.text}`}>{k}</span>{:else}{k}{/if}
            </td>
            <td class="v"><button class="copyable" use:tooltip={"Click to copy"} use:copyable={{ value: v, copied: "Header value copied" }}>{v}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if headers.length}
    <div class="empty-state small">No headers match “{filter.trim()}”.</div>
  {:else}
    <div class="empty-state small">The response has no headers.</div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 6px 16px;
    flex: none;
  }
  /* The filter shares the toolbar's free space with the spacer before Copy all. */
  .filter {
    flex: 1;
    display: flex;
  }
  .count,
  .small {
    font-size: 12px;
  }
  /* The toolbar above already spaces it. */
  .data-table {
    padding-top: 0;
  }
  /* A caching, CORS or rate-limit header: hover explains it. */
  .known {
    color: var(--accent);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
    cursor: help;
  }
</style>
