<!--
  The bottom bar: a thin strip along the bottom of the window, below the panel area,
  always shown. (Not the response pane's response status bar, in ResponseViewer.)

  Its rule: items show state only; clicking one opens the place where the user acts on
  it (a panel, a Settings section, a prompt). No item changes anything by itself.

  Two groups:
  - Left: the active tab's file, for a request tab or a File view: its line endings and
    encoding (`fileFacts`), and in a File view the caret's "Ln l, Col c" after them
    (`caretFact`, published by the view's editor), display only. Empty with no tab open,
    or while something not backed by a file covers the tabs (a History entry, a named
    exchange, the environment editor).
  - Right: workspace-wide, growing leftward from Problems. Its places, reading leftward
    from the right end: Problems, Runner, Scripts skipped, History off, Portability. In
    the markup (left to right) that's the reverse; each item goes in its own place, so
    adding one touches no other.

  Problems sits at the right end: its icon and count, "0" included, muted at zero and
  warning-toned with problems. The count is the settled one (`app.problems.count`),
  so it doesn't flicker while you type. Its button has a fixed width, room for "99+"
  (counts above 99 show as that), so a changing count moves nothing else in the bar.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { runCommand } from "../lib/commands";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shownProblemCount } from "../lib/problemCount";
  import { portabilityLabel, portabilityOff } from "../lib/portabilityLabel";
  import { fileFacts, type FileFact } from "../lib/fileFacts";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import { runSummary } from "../lib/runSummary";
  import Icon from "./Icon.svelte";

  const problems = $derived(app.problems.count);
  const shownCount = $derived(shownProblemCount(problems));
  const portability = $derived(portabilityLabel(app.portability.editors));
  const noEditors = $derived(portabilityOff(app.portability.editors));

  // The tab whose file the left group describes: the active one, unless a view not
  // backed by a file covers it.
  const fileTab = $derived(app.modal === "env" || app.history.openedIn(WORKSPACE_HISTORY) || app.shownExchange ? null : app.activeTab);
  const file = $derived(fileTab ? app.docs[fileTab.path]?.file : undefined);
  const facts = $derived(file && fileFacts(file));
  // In a File view, the caret's "Ln l, Col c" (#232). Last, so its changing width moves nothing else.
  const caret = $derived(fileTab?.kind === "file" ? app.fileCaret(fileTab.id) : undefined);

  // A panel item is a pressed toggle: clicking it while its panel is open closes the
  // panel, wherever focus is. (Its command, e.g. ⌘⇧M, closes it only with focus in it,
  // else focuses it.)
  function togglePanelItem(panel: "problems" | "runner") {
    if (app.panel === panel) app.hidePanel(panel);
    else runCommand(`toggle-${panel}`);
  }

  // The Runner item: the current Run (until the next, or the workspace closes).
  const run = $derived(app.runner);
  const summary = $derived(run && runSummary(run.items, run.running));
  // Once an ended Run's results have been seen in the Runner panel (shown after it
  // ended, or open as it ended), the item is muted until the next Run. In memory.
  let seenRun = $state("");
  $effect(() => {
    if (run && !run.running && app.panel === "runner") seenRun = run.runId;
  });
</script>

<footer class="bottom-bar" aria-label="Bottom bar">
  <div class="group file" role="group" aria-label="Active file">
    <!-- The active tab's file: line endings, encoding, and in a File view the caret. -->
    {#if facts}
      {@render shownFact(facts.endings)}
      {@render shownFact(facts.encoding)}
      {#if caret}{@render shownFact(caret)}{/if}
    {/if}
  </div>
  {#snippet shownFact(fact: FileFact)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: focusable so keyboard users reach its tooltip (controls.md, Bottom bar) -->
    <span class="fact" tabindex="0" use:tooltip={fact.tooltip}>{fact.label}</span>
  {/snippet}
  <div class="group workspace">
    <!-- 5. Portability: always shown, the editors whose Portability notes show (Settings → Portability). -->
    <button
      class="icon-btn quiet label-item portability"
      aria-label={`Portability: ${portability}`}
      use:tooltip={noEditors
        ? "Portability notes are off: turn on the editors you share .http files with in Settings"
        : `Portability notes show for ${portability}. Change the editors in Settings`}
      onclick={() => app.openSettings("portability")}
    >
      {portability}
    </button>
    <!-- 4. History off: only while the History switch is off; muted, a deliberate choice. -->
    {#if !app.history.enabled}
      <button
        class="icon-btn quiet label-item history-off"
        use:tooltip={"History is off: sends aren't recorded in History. Click to open the setting."}
        onclick={() => app.openSettings("history")}
      >
        History off
      </button>
    {/if}
    <!-- 3. Scripts skipped -->
    {#if app.trust.skipped}
      <button
        class="icon-btn quiet label-item scripts-skipped"
        use:tooltip={"Scripts skipped: sends in this workspace skip their scripts. Click to trust it, or keep skipping."}
        onclick={() => app.trust.askAgain()}
      >
        Scripts skipped
      </button>
    {/if}
    <!-- 2. Runner -->
    {#if run && summary}
      <button
        class="icon-btn quiet counted runner"
        class:active={app.panel === "runner"}
        class:seen={!run.running && seenRun === run.runId}
        aria-label={`Show Runner: ${summary.text}`}
        aria-pressed={app.panel === "runner"}
        use:tooltip={`${summary.text}. Opens the Runner panel`}
        onclick={() => togglePanelItem("runner")}
      >
        {#if run.running}
          <span class="run-progress" aria-hidden="true">
            <span class="passed" style:width="{summary.passedShare * 100}%"></span>
            <span class="failed" style:width="{summary.failedShare * 100}%"></span>
            <span class="sending" style:width="{summary.sendingShare * 100}%"></span>
          </span>
        {/if}
        <span class="count">{summary.label}{#if summary.failed}{" "}<span class="failed-count">{summary.failed}</span>{/if}</span>
      </button>
    {/if}
    <!-- 1. Problems: the right end. -->
    <button
      class="icon-btn quiet counted problems"
      class:active={app.panel === "problems"}
      class:attention={problems > 0}
      aria-label={problems ? `Show Problems (${problems})` : "Show Problems"}
      aria-pressed={app.panel === "problems"}
      use:tooltip={problems ? `Problems: ${problems} in the workspace's .http files` : "Problems: none in the workspace's .http files"}
      onclick={() => togglePanelItem("problems")}
    >
      <Icon name="alert" size={14} /><span class="count">{shownCount}</span>
    </button>
  </div>
</footer>

<style>
  .bottom-bar {
    height: 24px;
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-1);
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }
  /* The right group takes the slack, its items packed to the right end. */
  .group.workspace {
    flex: 1;
    justify-content: flex-end;
  }
  /* A display-only fact: muted text, a focus ring for keyboard users reaching its tooltip. */
  .fact {
    padding: 0 var(--space-1);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 11.5px;
    line-height: 20px;
    white-space: nowrap;
  }
  :global(:root[data-focus-marks]) .fact:focus {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .bottom-bar .icon-btn {
    height: 20px;
  }
  /* Text labels, not icons: as wide as their text. */
  .bottom-bar .label-item {
    flex: none;
    width: auto;
    padding: 0 var(--space-1);
    font-size: 11.5px;
    white-space: nowrap;
  }
  /* Scripts skipped is warning-toned. */
  .bottom-bar .scripts-skipped {
    color: var(--warning);
  }
  /* A fixed width (icon plus "99+"), icon and count centred in it: a longer count
     shifts them inside the button, never the button's neighbours. */
  .bottom-bar .problems {
    flex: none;
    width: 52px;
  }
  /* The Runner item: in the text colour while its Run wants a look, muted once an
     ended Run's results have been seen; failures warning-toned. */
  .bottom-bar .runner {
    flex: none;
    color: var(--text);
  }
  .bottom-bar .runner.seen:not(.active):not(:hover) {
    color: var(--muted);
  }
  .runner .failed-count {
    color: var(--warning);
  }
  /* A small determinate progress bar: finished requests (passed, then failed in the
     warning colour) out of all, then the request being sent, pulsing slowly. Nothing
     else in the bar animates, and nothing does under reduced motion. */
  .run-progress {
    display: flex;
    width: 48px;
    height: 4px;
    flex: none;
    border-radius: 2px;
    overflow: hidden;
    background: var(--border);
  }
  .run-progress .passed {
    background: var(--accent);
  }
  .run-progress .failed {
    background: var(--warning);
  }
  .run-progress .sending {
    background: var(--accent);
    opacity: 0.35;
    animation: run-pulse 1.6s ease-in-out infinite alternate;
  }
  @keyframes run-pulse {
    from {
      opacity: 0.15;
    }
    to {
      opacity: 0.6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .run-progress .sending {
      animation: none;
    }
  }
</style>
