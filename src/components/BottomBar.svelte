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

<footer class="bottom-bar" aria-label="Bottom bar">
  <div class="group file">
    <!-- The active tab's file: line endings, encoding, and in a File view the caret. -->
  </div>
  <div class="group workspace">
    <!-- 5. Portability -->
    <!-- 4. History off -->
    <!-- 3. Scripts skipped -->
    {#if app.trust.skipped}
      <button
        class="icon-btn quiet scripts-skipped"
        use:tooltip={"Scripts skipped: sends in this workspace skip their scripts. Click to trust it, or keep skipping."}
        onclick={() => app.trust.askAgain()}
      >
        Scripts skipped
      </button>
    {/if}
    <!-- 2. Runner -->
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
  /* Scripts skipped: warning-toned, a label rather than an icon. */
  .bottom-bar .scripts-skipped {
    flex: none;
    width: auto;
    padding: 0 var(--space-2);
    font-size: 11.5px;
    color: var(--warning);
  }
  /* A fixed width (icon plus "99+"), icon and count centred in it: a longer count
     shifts them inside the button, never the button's neighbours. */
  .bottom-bar .problems {
    flex: none;
    width: 52px;
  }
</style>
