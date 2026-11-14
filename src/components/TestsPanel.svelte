<!--
  The response viewer's Tests tab: each `client.test` and top-level
  `client.assert` from the response handler, and the handler's own error (a
  throw, the time limit, the memory limit), with pass or fail and the message.
  The viewer shows the tab only when the handler reported something.
-->
<script lang="ts">
  import type { TestResult } from "../lib/types";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";

  let { tests }: { tests: TestResult[] } = $props();

  const failed = $derived(tests.filter((t) => !t.passed).length);
  const passed = $derived(tests.length - failed);
</script>

<div class="tests">
  <div class="summary" aria-live="polite">
    {#if failed}<Badge tone="danger" size="md">{failed} failed</Badge>{/if}
    {#if passed}<Badge tone="success" size="md">{passed} passed</Badge>{/if}
  </div>
  <ul aria-label="Test results">
    {#each tests as t, i (i)}
      <li class:failed={!t.passed} data-testid="test-result">
        <span class="mark" aria-label={t.passed ? "Passed" : "Failed"}><Icon name={t.passed ? "check" : "x"} /></span>
        <div class="text">
          <div class="name selectable">{t.name}</div>
          {#if t.message}<div class="message mono selectable">{t.message}</div>{/if}
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .tests {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
  }
  .summary {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border);
  }
  .mark {
    flex: none;
    display: inline-flex;
    color: var(--success);
    padding-top: 2px;
  }
  li.failed .mark {
    color: var(--danger);
  }
  .text {
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .message {
    color: var(--muted);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
