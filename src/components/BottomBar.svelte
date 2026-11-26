<!--
  The bottom bar: a thin strip along the bottom of the window, below the panel area,
  always shown. (Not the response pane's response status bar, in ResponseViewer.)

  Its rule: items show state only; clicking one opens the place where the user acts on
  it (a panel, a Settings section, a prompt). No item changes anything by itself.

  Two groups:
  - Left: the active tab's file (empty for now).
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
  import { runSummary } from "../lib/runSummary";
  import Icon from "./Icon.svelte";

  const problems = $derived(app.problems.count);
  const shownCount = $derived(shownProblemCount(problems));

  // A pressed toggle: clicking it while the panel is open closes the panel, wherever
  // focus is. (The command, ⌘⇧M, closes it only with focus in it, else focuses it.)
  function toggleProblems() {
    if (app.panel === "problems") app.hidePanel("problems");
    else runCommand("toggle-problems");
  }

  // The Runner item: the current Run (until the next, or the workspace closes).
  const run = $derived(app.runner);
  const summary = $derived(run && runSummary(run.items, run.running));
  const runText = $derived(summary ? [summary.label, summary.failed].filter(Boolean).join(" ") : "");
  // Once an ended Run's results have been seen in the Runner panel (shown after it
  // ended, or open as it ended), the item is muted until the next Run. In memory.
  let seenRun = $state("");
  $effect(() => {
    if (run && !run.running && app.panel === "runner") seenRun = run.runId;
  });
  // A pressed toggle, like Problems.
  function toggleRunner() {
    if (app.panel === "runner") app.hidePanel("runner");
    else runCommand("toggle-runner");
  }
</script>

<footer class="bottom-bar" aria-label="Bottom bar">
  <div class="group file">
    <!-- The active tab's file: line endings, encoding, and in a File view the caret. -->
  </div>
  <div class="group workspace">
    <!-- 5. Portability -->
    <!-- 4. History off -->
    <!-- 3. Scripts skipped -->
    <!-- 2. Runner -->
    {#if run && summary}
      <button
        class="icon-btn quiet counted runner"
        class:active={app.panel === "runner"}
        class:seen={!run.running && seenRun === run.runId}
        aria-label={`Show Runner: ${runText}`}
        aria-pressed={app.panel === "runner"}
        use:tooltip={`${runText}. Opens the Runner panel`}
        onclick={toggleRunner}
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
      onclick={toggleProblems}
    >
      <Icon name="alert" size={13} /><span class="count">{shownCount}</span>
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
  .bottom-bar .icon-btn {
    height: 20px;
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
