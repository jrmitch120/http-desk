<!--
  The window's status bar: a thin strip along the bottom of the window, below the
  panel area, always shown. (Not the response pane's status bar, in ResponseViewer.)
  Problems sits at its right end: its icon and count, "0" included, muted at zero and
  warning-toned with problems. The count is the settled one (`app.problems.count`),
  so it doesn't flicker while you type. Its button has a fixed width, room for "99+"
  (counts above 99 show as that), so a changing count moves nothing else in the bar.
  Later items go to its left.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { runCommand } from "../lib/commands";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shownProblemCount } from "../lib/problemCount";
  import Icon from "./Icon.svelte";

  const problems = $derived(app.problems.count);
  const shownCount = $derived(shownProblemCount(problems));

  // A pressed toggle: clicking it while the panel is open closes the panel, wherever
  // focus is. (The command, ⌘⇧M, closes it only with focus in it, else focuses it.)
  function toggleProblems() {
    if (app.panel === "problems") app.hidePanel("problems");
    else runCommand("toggle-problems");
  }
</script>

<footer class="app-status-bar" aria-label="Status bar">
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
</footer>

<style>
  .app-status-bar {
    height: 24px;
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 var(--space-1);
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .app-status-bar .icon-btn {
    height: 20px;
  }
  /* At the right end, and a fixed width (icon plus "99+"), icon and count centred in
     it: a longer count shifts them inside the button, never the button's neighbours. */
  .app-status-bar .problems {
    margin-left: auto;
    width: 52px;
  }
</style>
