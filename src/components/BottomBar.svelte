<!--
  The bottom bar: a thin strip along the bottom of the window, below the panel area,
  always shown. (Not the response pane's response status bar, in ResponseViewer.)

  Its rule: items show state only; clicking one opens the place where the user acts on
  it (a panel, a Settings section, a prompt). No item changes anything by itself.

  Two groups:
  - Left: the active tab's file, for a request tab or a File view: its line endings and
    encoding (`fileFacts`), display only. Empty with no tab open, or while something not
    backed by a file covers the tabs (a History entry, a named exchange, the environment
    editor).
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
  import { fileFacts, type FileFact } from "../lib/fileFacts";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import Icon from "./Icon.svelte";

  const problems = $derived(app.problems.count);
  const shownCount = $derived(shownProblemCount(problems));

  // The tab whose file the left group describes: the active one, unless a view not
  // backed by a file covers it.
  const fileTab = $derived(app.modal === "env" || app.history.openedIn(WORKSPACE_HISTORY) || app.shownExchange ? null : app.activeTab);
  const file = $derived(fileTab ? app.docs[fileTab.path]?.file : undefined);
  const facts = $derived(file && fileFacts(file));

  // A pressed toggle: clicking it while the panel is open closes the panel, wherever
  // focus is. (The command, ⌘⇧M, closes it only with focus in it, else focuses it.)
  function toggleProblems() {
    if (app.panel === "problems") app.hidePanel("problems");
    else runCommand("toggle-problems");
  }
</script>

<footer class="bottom-bar" aria-label="Bottom bar">
  <div class="group file" role="group" aria-label="Active file">
    <!-- The active tab's file: line endings, encoding, and in a File view the caret. -->
    {#if facts}
      {@render shownFact(facts.endings)}
      {@render shownFact(facts.encoding)}
    {/if}
  </div>
  {#snippet shownFact(fact: FileFact)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: focusable so keyboard users reach its tooltip (controls.md, Bottom bar) -->
    <span class="fact" tabindex="0" use:tooltip={fact.tooltip}>{fact.label}</span>
  {/snippet}
  <div class="group workspace">
    <!-- 5. Portability -->
    <!-- 4. History off -->
    <!-- 3. Scripts skipped -->
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
  /* A fixed width (icon plus "99+"), icon and count centred in it: a longer count
     shifts them inside the button, never the button's neighbours. */
  .bottom-bar .problems {
    flex: none;
    width: 52px;
  }
</style>
