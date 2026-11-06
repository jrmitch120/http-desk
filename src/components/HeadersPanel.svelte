<!--
  The response viewer's Headers tab: a name filter, click-to-copy values,
  Copy all, and hover explanations of well-known caching, CORS and rate-limit
  headers (src/lib/headers.ts).
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { explainHeader, filterHeaders, headersText, type Header } from "../lib/headers";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";

  let { headers }: { headers: Header[] } = $props();

  let filter = $state("");
  const shown = $derived(filterHeaders(headers, filter));

  /** Copies one value, unless the click ended a drag that selected part of it (the user copies that themselves). */
  async function copyValue(e: MouseEvent, value: string) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && (e.currentTarget as Node).contains(sel.anchorNode)) return;
    await navigator.clipboard.writeText(value);
    app.toast("success", "Header value copied");
  }

  /** Always every header, not just the filtered ones: "all" means all, for pasting into a bug report. */
  async function copyAll() {
    await navigator.clipboard.writeText(headersText(headers));
    app.toast("success", "Headers copied");
  }
</script>

<div class="toolbar">
  <div class="filter">
    <Icon name="search" size={13} />
    <input class="input" placeholder="Filter headers" aria-label="Filter headers" spellcheck="false" bind:value={filter} />
  </div>
  {#if filter.trim()}<span class="muted count">{shown.length} of {headers.length}</span>{/if}
  <span class="spacer"></span>
  <button class="btn small ghost" aria-label="Copy all headers" use:tooltip={"Copy all headers as Name: value lines"} disabled={!headers.length} onclick={copyAll}>
    <Icon name="copy" size={13} />Copy all
  </button>
</div>
<div class="table-wrap">
  {#if shown.length}
    <table aria-label="Response headers">
      <tbody>
        {#each shown as [k, v], i (i)}
          {@const info = explainHeader(k)}
          <tr>
            <td class="k">
              {#if info}<span class="known" use:tooltip={`${info.group}: ${info.text}`}>{k}</span>{:else}{k}{/if}
            </td>
            <td class="v"><button class="copyable" use:tooltip={"Click to copy"} onclick={(e) => copyValue(e, v)}>{v}</button></td>
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
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .filter .input {
    height: 26px;
    width: 200px;
  }
  .count,
  .small {
    font-size: 12px;
  }
  .table-wrap {
    flex: 1;
    overflow: auto;
    padding: 0 16px 16px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .k {
    font-weight: 600;
    white-space: nowrap;
    width: 1%;
    padding-right: 24px;
    color: var(--text-2);
  }
  /* A caching, CORS or rate-limit header: hover explains it. */
  .known {
    color: var(--accent);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
    cursor: help;
  }
  .v {
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
