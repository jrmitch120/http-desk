<!--
  History entries as rows, newest first: method, URL as sent, status (or Error,
  Cancelled), when it was sent, duration and size. Clicking a row opens it. Shared
  by History views (the request's, in the response pane).
-->
<script lang="ts">
  import type { HistorySummary } from "../lib/types";
  import { formatBytes, formatDuration } from "../lib/http";
  import { sentAt } from "../lib/history.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";

  let { entries, onopen }: { entries: HistorySummary[]; onopen: (entry: HistorySummary) => void } = $props();
</script>

<ul class="entries" aria-label="History entries">
  {#each entries as e (e.id)}
    <li>
      <button class="row" onclick={() => onopen(e)}>
        <Badge method={e.method} />
        <span class="url mono">{e.url}</span>
        <span class="spacer"></span>
        {#if e.status !== null}
          <Badge status={e.status}>{e.status}</Badge>
        {:else if e.cancelled}
          <Badge>Cancelled</Badge>
        {:else}
          <span class="tip" use:tooltip={e.error ?? ""}><Badge tone="danger">Error</Badge></span>
        {/if}
        <span class="metric muted">{sentAt(e.time)}</span>
        <span class="metric muted">{formatDuration(e.durationMs)}</span>
        <span class="metric muted size">{e.size === null ? "" : formatBytes(e.size)}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .entries {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 5px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--hover);
  }
  .url {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .tip {
    display: flex;
  }
  .metric {
    flex: none;
    font-size: 12px;
  }
  .size {
    min-width: 56px;
    text-align: right;
  }
</style>
