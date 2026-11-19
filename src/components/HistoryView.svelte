<!--
  A History view (`view`): the open workspace's entries (the sidebar's), or one
  request's (`request`, a tab's), newest first, narrowed by status class and text
  (both filtered in the shell's query), HISTORY_PAGE at a time: scrolling to the end
  lists the next page. It lists again after each send (keeping as many as it showed)
  and when the workspace changes. Used by WorkspaceHistory and RequestHistory, which
  show the entry it opens.

  Clicking an entry opens it read-only in the view (`app.history.open`). Its context
  menu opens it, compares it (with `current`, the tab's response, else the next newer
  entry of its request: `compareTarget`) or deletes it; two entries selected with their
  boxes compare with each other. Delete on a row, and the workspace view's Clear
  workspace history, ask first (`app.history.delete`, `app.history.clearWorkspace`).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { app, type RunState } from "../lib/store.svelte";
  import { api, errorMessage } from "../lib/api";
  import { compareTarget, HISTORY_PAGE, historyLinkKey, sentAt, WORKSPACE_HISTORY, type HistoryViewId } from "../lib/history.svelte";
  import { menu } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import type { HistoryLink, HistoryQuery, HistoryStatusClass, HistorySummary } from "../lib/types";
  import HistoryList from "./HistoryList.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import FilterField from "./FilterField.svelte";
  import Select from "./Select.svelte";

  interface Props {
    /**
     * The view: the sidebar's (`WORKSPACE_HISTORY`), listing every entry in the workspace
     * with its file, laid out for a narrow pane; or a tab's.
     */
    view: HistoryViewId;
    /** A tab's view: its request's entries. */
    request?: HistoryLink | null;
    /** A tab's view: the tab's response, which Compare compares an entry with. */
    current?: RunState;
    /** What an empty list says when nothing narrows it. */
    empty: string;
  }

  let { view, request = null, current, empty }: Props = $props();

  /** The sidebar's view: every request's entries (so each shows its file), in a narrow
   *  pane (two lines a row, and the status classes a dropdown). */
  const workspace = $derived(view === WORKSPACE_HISTORY);
  /** The entries listed now. */
  let entries = $state<HistorySummary[] | null>(null);
  /** The entry the view has open. */
  const shown = $derived(app.history.openedIn(view)?.entry.id ?? null);

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
  const requestKey = $derived(request && historyLinkKey(request.filePath, request));

  // The entries selected for Compare, in the order they were selected; none for another request.
  let selected = $state<number[]>([]);
  const chosen = $derived(selected.flatMap((id) => entries?.find((e) => e.id === id) ?? []));
  $effect(() => {
    void requestKey;
    selected = [];
  });

  function select(entry: HistorySummary, on: boolean) {
    selected = on ? [...selected, entry.id] : selected.filter((id) => id !== entry.id);
  }

  const open = (entry: HistorySummary) => app.history.open(view, entry);

  function entryMenu(event: MouseEvent, entry: HistorySummary, index: number) {
    const target = compareTarget(entries ?? [], index, current, workspace);
    menu.show(event, [
      { label: "Open", action: () => open(entry) },
      target
        ? {
            label: "response" in target ? "Compare with the current response" : `Compare with the next newer entry (${sentAt(target.entry.time)})`,
            icon: "columns",
            action: () => app.history.compare(entry, target),
          }
        : { label: "Compare", icon: "columns", disabled: true },
      { separator: true },
      { label: "Delete…", icon: "trash", danger: true, action: () => app.history.delete(entry) },
    ]);
  }

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

<div class="history-view" class:narrow={workspace}>
  <div class="filters">
    {#if workspace}
      <!-- Six classes side by side don't fit a narrow pane: a dropdown there. -->
      <Select size="sm" class="status" label="Status class" options={STATUSES.map((o) => (o.value === "all" ? { ...o, label: "All statuses" } : o))} value={status} onchange={(s) => (status = s)} />
    {:else}
      <SegmentedControl label="Status class" options={STATUSES} value={status} onchange={(s) => (status = s)} />
    {/if}
    <div class="text">
      <FilterField label="Filter History" placeholder={workspace ? "Filter by URL, file…" : "Filter by URL, method, file or name"} value={typed} oninput={onTextInput} />
      {#if workspace}
        <button class="icon-btn" aria-label="Clear workspace history" use:tooltip={"Clear workspace history: delete every entry of this workspace"} disabled={entries?.length === 0 && !filtered} onclick={() => app.history.clearWorkspace()}><Icon name="trash" /></button>
      {/if}
    </div>
  </div>
  {#if chosen.length}
    <div class="selection">
      <span class="muted">{chosen.length} selected</span>
      <span class="spacer"></span>
      <button class="btn small ghost" onclick={() => (selected = [])}>Clear</button>
      <button class="btn small" disabled={chosen.length !== 2} use:tooltip={chosen.length === 2 ? null : "Select two entries to compare"} onclick={() => app.history.compare(chosen[0], { entry: chosen[1] })}>Compare selected</button>
    </div>
  {/if}
  {#if entries?.length === 0}
    <div class="empty-state small">{filtered ? "No History entries match" : empty}</div>
  {:else if entries}
    <HistoryList {entries} onopen={open} current={shown} file={workspace} narrow={workspace} {selected} onselect={select} onmenu={entryMenu} ondelete={(e) => app.history.delete(e)} footer={more ? showMoreButton : undefined} />
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
    flex-wrap: nowrap;
    gap: 6px;
    padding: 2px 10px 6px;
  }
  .text {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 160px;
  }
  .narrow .text {
    min-width: 0;
  }
  .narrow :global(.status) {
    flex: none;
  }
  .small {
    font-size: 12px;
  }
  .selection {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex: none;
  }
  .narrow .selection {
    padding: 4px 10px;
  }
  .spacer {
    flex: 1;
  }
</style>
