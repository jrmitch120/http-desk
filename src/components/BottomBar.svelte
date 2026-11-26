<!--
  The bottom bar: a thin strip along the bottom of the window, below the panel area,
  always shown. (Not the response pane's response status bar, in ResponseViewer.)

  Its rule: items show state only; clicking one opens the place where the user acts on
  it (a panel, a Settings section, a prompt). No item changes anything by itself. And
  nothing moves (#235): every workspace item has a permanent slot of fixed width, and a
  condition changes only what's inside its slot, never whether it's there or how wide.

  Three columns:
  - Left: the active tab's file, for a request tab or a File view: its line endings and
    encoding (`fileFacts`), and in a File view the caret's "Ln l, Col c" after them
    (`caretFact`, published by the view's editor), display only. Empty with no tab open,
    or while something not backed by a file covers the tabs (a History entry, a named
    exchange, the environment editor). It comes and goes, but nothing follows it.
  - Centre: the Runner, in the true centre of the window whatever the sides hold.
  - Right: workspace-wide, left to right: Portability, History, Scripts, Problems.

  Problems sits at the right end: its icon and count, "0" included, muted at zero and
  warning-toned with problems. The count is the settled one (`app.problems.count`),
  so it doesn't flicker while you type. Its button has a fixed width, room for "99+"
  (counts above 99 show as that).

  A slot's fixed width comes from its widest text (`data-widest`, laid out invisibly
  under the shown text), so it follows the font rather than a guessed pixel width.
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
  // In a File view, the caret's "Ln l, Col c" (#232). Last, with a minimum width, so a changing position moves nothing.
  const caret = $derived(fileTab?.kind === "file" ? app.fileCaret(fileTab.id) : undefined);

  // A panel item is a pressed toggle: clicking it while its panel is open closes the
  // panel, wherever focus is. (Its command, e.g. ⌘⇧M, closes it only with focus in it,
  // else focuses it.)
  function togglePanelItem(panel: "problems" | "runner") {
    if (app.panel === panel) app.hidePanel(panel);
    else runCommand(`toggle-${panel}`);
  }

  // The Runner slot: the current Run (until the next, or the workspace closes), or a
  // muted "Runner" before any.
  const run = $derived(app.runner);
  const summary = $derived(run && runSummary(run.items, run.running));
  // Once an ended Run's results have been seen in the Runner panel (shown after it
  // ended, or open as it ended), the item is muted until the next Run. In memory.
  let seenRun = $state("");
  $effect(() => {
    if (run && !run.running && app.panel === "runner") seenRun = run.runId;
  });
  const runnerMuted = $derived(!run || !summary || (!run.running && seenRun === run.runId));

  // The Scripts slot. Skipped: clicking asks again to trust the workspace. Otherwise
  // (trusted, or not asked yet) it opens Settings at Trusted workspaces, where the trust
  // is kept and revoked: the open workspace is listed there once trusted, and the
  // section says HttpDesk asks the first time a send would run a script.
  const skipped = $derived(app.trust.skipped);
  const trusted = $derived(app.trust.trusted);
  const scriptsTooltip = $derived(
    skipped
      ? "Scripts skipped: sends in this workspace skip their scripts. Click to trust it, or keep skipping."
      : trusted
        ? "Scripts run: this workspace is trusted. Click to see it in Settings → Trusted workspaces."
        : "Scripts: this workspace isn't trusted yet; HttpDesk asks the first time a send would run a script. Click to open Settings → Trusted workspaces.",
  );
  function openScripts() {
    if (skipped) app.trust.askAgain();
    else app.openSettings("trust");
  }

  const historyOn = $derived(app.history.enabled);
</script>

<footer class="bottom-bar" aria-label="Bottom bar">
  <div class="group file" role="group" aria-label="Active file">
    <!-- The active tab's file: line endings, encoding, and in a File view the caret. -->
    {#if facts}
      {@render shownFact(facts.endings)}
      {@render shownFact(facts.encoding)}
      {#if caret}{@render shownFact(caret, "Ln 9999, Col 999")}{/if}
    {/if}
  </div>
  {#snippet shownFact(fact: FileFact, atLeast?: string)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: focusable so keyboard users reach its tooltip (controls.md, Bottom bar) -->
    <span class="fact" class:at-least={atLeast} data-widest={atLeast} tabindex="0" use:tooltip={fact.tooltip}>{#if atLeast}<span class="shown">{fact.label}</span>{:else}{fact.label}{/if}</span>
  {/snippet}
  <div class="group run">
    <!-- The Runner, in the centre: one fixed-width button, compact text over a progress line along its bottom edge. -->
    <button
      class="icon-btn quiet runner"
      class:active={app.panel === "runner"}
      class:muted={runnerMuted}
      aria-label={summary ? `Show Runner: ${summary.text}` : "Show Runner"}
      aria-pressed={app.panel === "runner"}
      use:tooltip={summary ? `${summary.text}. Opens the Runner panel` : "Runner: no Run yet. Opens the Runner panel"}
      onclick={() => togglePanelItem("runner")}
    >
      <span class="shown">{#if summary}{summary.compact.label}{#if summary.compact.failed}{" "}<span class="failed-count">{summary.compact.failed}</span>{/if}{:else}Runner{/if}</span>
      {#if summary}
        <span class="run-line" aria-hidden="true">
          <span class="passed" style:width="{summary.passedShare * 100}%"></span>
          <span class="failed" style:width="{summary.failedShare * 100}%"></span>
          <span class="sending" style:width="{summary.sendingShare * 100}%"></span>
        </span>
      {/if}
    </button>
  </div>
  <div class="group workspace">
    <!-- Portability: the editors whose Portability notes show (Settings → Portability). -->
    <button
      class="icon-btn quiet label-item portability"
      aria-label={`Portability: ${portability}`}
      use:tooltip={noEditors
        ? "Portability notes are off: turn on the editors you share .http files with in Settings"
        : `Portability notes show for ${portability}. Change the editors in Settings`}
      onclick={() => app.openSettings("portability")}
    >
      <span class="slot" data-widest="VS Code · Rider"><span class="shown">{portability}</span></span>
    </button>
    <!-- History: muted "History" while the switch is on, "History off" while it's off. -->
    <button
      class="icon-btn quiet label-item history"
      class:off={!historyOn}
      aria-label={historyOn ? "History: on" : "History off"}
      use:tooltip={historyOn
        ? "History is on: sends are recorded in History. Click to open the setting."
        : "History is off: sends aren't recorded in History. Click to open the setting."}
      onclick={() => app.openSettings("history")}
    >
      <span class="slot" data-widest="History off"><span class="shown">{historyOn ? "History" : "History off"}</span></span>
    </button>
    <!-- Scripts: muted "Scripts", or "Scripts skipped" warning-toned while the skip is in force. -->
    <button
      class="icon-btn quiet label-item scripts"
      class:skipped
      aria-label={skipped ? "Scripts skipped" : trusted ? "Scripts: trusted" : "Scripts: not trusted yet"}
      use:tooltip={scriptsTooltip}
      onclick={openScripts}
    >
      <span class="slot" data-widest="Scripts skipped"><span class="shown">{skipped ? "Scripts skipped" : "Scripts"}</span></span>
    </button>
    <!-- Problems: the right end. -->
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
  /* Three columns: the sides share what's left equally, so the Runner is centred. */
  .bottom-bar {
    height: 24px;
    flex: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-1);
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .group.file {
    overflow: hidden;
  }
  .group.workspace {
    justify-content: flex-end;
  }
  /* A display-only fact: muted text, a focus ring for keyboard users reaching its tooltip. */
  .fact {
    flex: none;
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
  /* At least as wide as its widest text (the caret: "Ln 9999, Col 999"), with tabular numerals. */
  .fact.at-least {
    display: inline-grid;
    font-variant-numeric: tabular-nums;
  }
  .fact.at-least::before,
  .fact.at-least > .shown {
    grid-area: 1 / 1;
  }
  .fact.at-least::before {
    content: attr(data-widest);
    visibility: hidden;
  }
  .bottom-bar .icon-btn {
    height: 20px;
  }
  /* Text labels, not icons. */
  .bottom-bar .label-item {
    flex: none;
    width: auto;
    padding: 0 var(--space-1);
    font-size: 11.5px;
    white-space: nowrap;
  }
  /* A fixed-width slot: exactly as wide as its widest text, laid out invisibly; the
     shown text sits centred over it, cut off with an ellipsis if it's ever longer. */
  .slot {
    position: relative;
    display: inline-block;
    white-space: nowrap;
  }
  .slot::before {
    content: attr(data-widest);
    visibility: hidden;
  }
  .slot > .shown {
    position: absolute;
    inset: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  }
  .bottom-bar .history.off {
    color: var(--text);
  }
  .bottom-bar .scripts.skipped {
    color: var(--warning);
  }
  /* A fixed width (icon plus "99+"), icon and count centred in it. */
  .bottom-bar .problems {
    flex: none;
    width: 52px;
  }
  /* The Runner: one fixed-width button (its hover box), compact text centred in it with
     tabular numerals, so no state moves or resizes it. In the text colour while its Run
     wants a look; muted with no Run yet, or once an ended Run's results have been seen.
     The failed count ("✕ k") warning-toned. */
  .bottom-bar .runner {
    position: relative;
    overflow: hidden;
    flex: none;
    width: 120px;
    padding: 0 var(--space-1);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--text);
  }
  .runner > .shown {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bottom-bar .runner.muted:not(.active):not(:hover) {
    color: var(--muted);
  }
  .runner .failed-count {
    color: var(--warning);
  }
  /* A determinate progress line, 2 px along the button's bottom edge and as wide as it:
     finished requests (passed in the success colour, then failed in the warning colour)
     out of all, then the request being sent, pulsing slowly. Dimmed with the item once
     its Run has been seen. Nothing else in the bar animates, and nothing does under
     reduced motion. Not there before any Run. */
  .run-line {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    display: flex;
  }
  .bottom-bar .runner.muted:not(.active):not(:hover) .run-line {
    opacity: 0.45;
  }
  .run-line .passed {
    background: var(--success);
  }
  .run-line .failed {
    background: var(--warning);
  }
  .run-line .sending {
    background: var(--text);
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
    .run-line .sending {
      animation: none;
    }
  }
</style>
