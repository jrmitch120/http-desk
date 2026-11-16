<!--
  The pass/fail marker of a request whose latest send ran tests (`app.testMark`),
  shown on its tab and its tree row: a green check when every test passed, a
  red cross when any failed. Nothing when the request has no marker.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";

  let { requestKey }: { requestKey: string } = $props();

  const mark = $derived(app.testMark(requestKey));
</script>

{#if mark}
  <span class="test-mark {mark}" role="img" aria-label={mark === "passed" ? "Tests passed" : "Tests failed"} use:tooltip>
    <Icon name={mark === "passed" ? "check" : "x"} size={9} />
  </span>
{/if}

<style>
  /* A filled disc in the state's color, so it reads apart from the tab's close cross and the unsaved dot. */
  .test-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: currentColor;
  }
  .test-mark :global(svg) {
    color: var(--on-accent);
    stroke-width: 3.5;
  }
  .passed {
    color: var(--success);
  }
  .failed {
    color: var(--danger);
  }
</style>
