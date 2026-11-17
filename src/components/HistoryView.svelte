<!--
  A History view's list: the open workspace's entries, or one request's (`request`),
  newest first, narrowed by status class and text (both filtered in the shell's
  query), HISTORY_PAGE at a time: scrolling to the end lists the next page. It lists
  again after each send (keeping as many as it showed) and when the workspace changes.
  Used by the sidebar's History (the workspace's) and the response pane's (the request's).
  Compare's selection, the context menu and row actions pass through to HistoryList.
  Clear workspace history (whichever view it's in) and Delete on a row ask first
  (`app.history.clearWorkspace`, `app.history.delete`).
-->
<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { app } from "../lib/store.svelte";
  import { api, errorMessage } from "../lib/api";
  import { HISTORY_PAGE } from "../lib/history.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import type { HistoryLink, HistoryQuery, HistoryStatusClass, HistorySummary } from "../lib/types";
  import HistoryList from "./HistoryList.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import FilterField from "./FilterField.svelte";

  interface Props {
    /** Only this request's entries; every entry in the workspace without one. */
    request?: HistoryLink | null;
    /** What an empty list says when nothing narrows it. */
    empty: string;
    onopen: (entry: HistorySummary) => void;
    /** The entry shown now. */
    current?: number | null;
    /** Shows each entry's file. */
    file?: boolean;
    /** Two lines a row, and the filters stacked, for a narrow pane. */
    narrow?: boolean;
    /** The entries listed now, for the owner to read (bind it). */
    entries?: HistorySummary[] | null;
    /** Passed through to HistoryList: Compare's selection, the row's context menu, row actions. */
    selected?: number[];
    onselect?: (entry: HistorySummary, selected: boolean) => void;
    onmenu?: (event: MouseEvent, entry: HistorySummary, index: number) => void;
    start?: Snippet<[HistorySummary]>;
    end?: Snippet<[HistorySummary]>;
  }

  let {
    request = null,
    empty,
    onopen,
    current = null,
    file = false,
    narrow = false,
    entries = $bindable(null),
    selected,
    onselect,
    onmenu,
    start,
    end,
  }: Props = $props();

  type Status = "all" | HistoryStatusClass;
  const STATUSES: SegmentedOption<Status>[] = [
    { value: "all", label: "All" },
    { value: "2xx", label: "2xx" },
    { value: "3xx", label: "3xx" },
    { value: "4xx", label: "4xx" },
    { value: "5xx", label: "5xx" },
    { value: "error", label: "Errors" },
  ];
  let status = $state<Status>("all");
  /** The text filter as typed, and as asked for (after a pause in typing). */
  let typed = $state("");
  let text = $state("");
  let typing: ReturnType<typeof setTimeout> | undefined;
  function onTextInput(value: string) {
    typed = value;
    clearTimeout(typing);
    typing = setTimeout(() => (text = value.trim()), 150);
  }
  $effect(() => () => clearTimeout(typing));
  const filtered = $derived(status !== "all" || !!text);

  // What the list depends on: a named request's URL can change under it.
  const requestKey = $derived(request && JSON.stringify(request.name ? [request.filePath, request.name] : request));

  /** Whether the last page was full, so there may be more. */
  let more = $state(false);
  let loading = false;
  let seq = 0;

  /** Lists `limit` entries from `offset`: the first page replaces the list, a later one adds to it. */
  async function load(offset: number, limit: number) {
    const run = ++seq;
    loading = true;
    const query: HistoryQuery = { offset, limit };
    if (request) query.request = { ...request };
    if (status !== "all") query.status = status;
    if (text) query.text = text;
    try {
      const page = await api.listHistory(query);
      if (run !== seq) return;
      entries = offset ? [...(entries ?? []), ...page] : page;
      more = page.length === limit;
    } catch (e) {
      if (run === seq) app.toast("error", errorMessage(e));
    } finally {
      if (run === seq) loading = false;
    }
  }

  // New filters, request or workspace: the first page. A send: what was listed, again.
  let listedFor = "";
  $effect(() => {
    const key = JSON.stringify([app.root, requestKey, status, text]);
    void app.history.revision;
    untrack(() => {
      const limit = key === listedFor ? Math.max(HISTORY_PAGE, entries?.length ?? 0) : HISTORY_PAGE;
      listedFor = key;
      void load(0, limit);
    });
  });

  function showMore() {
    if (more && !loading && entries) void load(entries.length, HISTORY_PAGE);
  }

  /** Shows the next page when `node` (at the end of the list) scrolls into view. */
  function whenSeen(node: HTMLElement) {
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && showMore());
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div class="history-view" class:narrow>
  <div class="filters">
    <SegmentedControl label="Status class" options={STATUSES} value={status} onchange={(s) => (status = s)} />
    <div class="text">
      <FilterField label="Filter History" placeholder="Filter by URL, method, file or name" value={typed} oninput={onTextInput} />
      <button class="icon-btn" aria-label="Clear workspace history" use:tooltip={"Clear workspace history: delete every entry of this workspace"} disabled={entries?.length === 0 && !filtered} onclick={() => app.history.clearWorkspace()}><Icon name="trash" /></button>
    </div>
  </div>
  {#if entries?.length === 0}
    <div class="empty-state small">{filtered ? "No History entries match" : empty}</div>
  {:else if entries}
    <HistoryList {entries} {onopen} {current} {file} {narrow} {selected} {onselect} {onmenu} ondelete={(e) => app.history.delete(e)} {start} {end} footer={more ? showMoreButton : undefined} />
  {/if}
</div>

{#snippet showMoreButton()}
  <button class="btn small ghost" use:whenSeen onclick={showMore}>Show more</button>
{/snippet}

<style>
  .history-view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 6px 16px 2px;
    flex: none;
  }
  .narrow .filters {
    flex-direction: column;
    align-items: stretch;
    padding: 2px 10px 6px;
  }
  .text {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 160px;
  }
  .small {
    font-size: 12px;
  }
</style>
