<!--
  The sidebar's History view: every entry in the open workspace, newest first,
  whatever request it came from (renamed and deleted ones too), with its file.
  HistoryView lists, filters, opens, compares and deletes them, and clears the
  workspace's History; the entry opened shows read-only in HistoryEntryView. While
  the History switch is off it says so instead (HistoryOff).

  Focus History (`app.focusHistory`) focuses the entry last focused here, else the
  list's Tab stop, once the list has loaded; an empty History, its empty message.
-->
<script module lang="ts">
  /** The last `app.focusHistory` ask the list took focus for. */
  let historyAsked = 0;
  /** The entry last focused, and in which workspace: kept while the Explorer shows
   *  in this view's place (which unmounts it), for Focus History to go back to. */
  let lastEntry: { root: string | null; id: string } | null = null;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../lib/store.svelte";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";

  let section: HTMLElement | undefined = $state();

  const ENTRY = '[role="list"][aria-label="History entries"] [role="listitem"]';

  function onfocusin(e: FocusEvent) {
    const row = e.target instanceof HTMLElement && e.target.matches(ENTRY) ? e.target : null;
    if (row?.dataset.id) lastEntry = { root: app.root, id: row.dataset.id };
  }

  /** What Focus History focuses, or null while the entries are still loading. */
  function target(el: HTMLElement): HTMLElement | null {
    const list = el.querySelector<HTMLElement>('[role="list"][aria-label="History entries"]');
    if (list) {
      const rows = [...list.querySelectorAll<HTMLElement>('[role="listitem"]')];
      const last = lastEntry?.root === app.root ? rows.find((r) => r.dataset.id === lastEntry?.id) : undefined;
      return last ?? rows.find((r) => r.tabIndex === 0) ?? rows.find((r) => r.hasAttribute("aria-current")) ?? rows[0] ?? list;
    }
    // No entries (or History off): what says so.
    return el.querySelector<HTMLElement>('.empty-state[tabindex="-1"]') ?? el.querySelector<HTMLElement>(".empty-state button");
  }

  // Each ask once, when the sidebar shows the list (or its empty message).
  $effect(() => {
    const el = section;
    const ask = app.focusHistory;
    if (!el || ask === historyAsked || !app.sidebarShown) return;
    return untrack(() => {
      const tryFocus = () => {
        const to = target(el);
        if (!to) return false;
        historyAsked = ask;
        to.focus();
        return true;
      };
      if (tryFocus()) return;
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
