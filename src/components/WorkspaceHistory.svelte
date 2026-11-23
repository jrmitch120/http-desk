<!--
  The sidebar's History view: every entry in the open workspace, newest first,
  whatever request it came from (renamed and deleted ones too), with its file.
  HistoryView lists, filters, opens, compares and deletes them, and clears the
  workspace's History; the entry opened shows read-only in HistoryEntryView. While
  the History switch is off it says so instead (HistoryOff).

  Focus History (`app.historyFocusWanted`) focuses the entry last focused here, else
  the list's Tab stop, once the list has loaded; an empty History, its empty message.
-->
<script module lang="ts">
  /** The entry last focused, and in which workspace: kept while the Explorer shows
   *  in this view's place (which unmounts it), for Focus History to go back to. */
  let lastEntry: { root: string | null; id: string } | null = null;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../lib/store.svelte";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import { focusList, ROW } from "../lib/rovingList";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";

  let section: HTMLElement | undefined = $state();

  // The History entries are the only list rows in the view.
  function onfocusin(e: FocusEvent) {
    const row = e.target instanceof HTMLElement && e.target.matches(ROW) ? e.target : null;
    if (row?.dataset.id) lastEntry = { root: app.root, id: row.dataset.id };
  }

  /**
   * Focus History: the entry last focused here, else the list's Tab stop (`focusList`);
   * with no entries (or History off), what says so. False while the entries are still
   * loading, before there's a list.
   */
  function focusHistory(el: HTMLElement): boolean {
    const rows = lastEntry?.root === app.root ? [...el.querySelectorAll<HTMLElement>(ROW)] : [];
    const last = rows.find((r) => r.dataset.id === lastEntry?.id);
    if (last) last.focus();
    else if (!focusList(el)) {
      const empty = el.querySelector<HTMLElement>('.empty-state[tabindex="-1"]') ?? el.querySelector<HTMLElement>(".empty-state button");
      if (!empty) return false;
      empty.focus();
    }
    return true;
  }

  // Each ask once, when the sidebar shows the list (or its empty message).
  $effect(() => {
    const el = section;
    if (!el || !app.historyFocusWanted || !app.sidebarShown) return;
    return untrack(() => {
      const tryFocus = () => {
        if (!focusHistory(el)) return false;
        app.historyFocusWanted = false;
        return true;
      };
      if (tryFocus()) return;
      // The list comes once the entries have loaded.
      const observer = new MutationObserver(() => tryFocus() && observer.disconnect());
      observer.observe(el, { childList: true, subtree: true });
      return () => observer.disconnect();
    });
  });
</script>

<section class="workspace-history" aria-label="Workspace History" bind:this={section} {onfocusin}>
  {#if !app.history.enabled}
    <HistoryOff />
  {:else}
    <HistoryView view={WORKSPACE_HISTORY} empty="No History in this workspace yet" />
  {/if}
</section>

<style>
  .workspace-history {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
