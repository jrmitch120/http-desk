<!--
  The Runner panel (in the panel area, PanelArea.svelte): the last run (`app.runner`)
  live, one row per request with its state, status, time and tests, and Stop while
  it runs. Selecting a row opens its result in the response viewer beside the list;
  a run never touches what the tabs show.
-->
<script lang="ts">
  import { app, type RunItem } from "../lib/store.svelte";
  import { formatDuration } from "../lib/http";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";

  const runner = $derived(app.runner);
  let selected = $state<number | null>(null);
  // A new run starts with nothing open.
  let shownRun = "";
  $effect.pre(() => {
    if (runner?.runId !== shownRun) {
      shownRun = runner?.runId ?? "";
      selected = null;
    }
  });
  const item = $derived(selected === null ? undefined : runner?.items[selected]);
  const opened = $derived(item && (item.response || item.error) ? item : undefined);

  const count = (state: RunItem["state"]) => runner?.items.filter((i) => i.state === state).length ?? 0;
  const summary = $derived.by(() => {
    if (!runner) return "";
    const parts = [`${count("passed")} passed`, `${count("failed")} failed`];
    const stopped = count("cancelled") + count("notRun");
    if (stopped) parts.push(`${stopped} didn't run`);
    return parts.join(" · ");
  });

  const STATE_LABEL: Record<RunItem["state"], string> = {
    queued: "Waiting",
    sending: "Sending…",
    passed: "Passed",
    failed: "Failed",
    cancelled: "Stopped",
    notRun: "Didn't run",
  };

  function tests(i: RunItem): string {
    const all = i.response?.tests ?? [];
    if (!all.length) return "";
    const failed = all.filter((t) => !t.passed).length;
    return failed ? `${all.length - failed} passed · ${failed} failed` : `${all.length} passed`;
  }
</script>

<div class="runner">
  <div class="toolbar">
    {#if runner}
      <span class="title selectable">{runner.title}</span>
      <span class="muted" aria-live="polite">{runner.running ? "Running…" : summary}</span>
    {:else}
      <span class="muted">Run a file from its menu in the explorer, or Request → Run File.</span>
    {/if}
    <span class="spacer"></span>
    {#if runner?.running}
      <button class="btn small" onclick={() => app.stopRun()}><Icon name="stop" />Stop</button>
    {/if}
  </div>
  {#if runner}
    <div class="body">
      <ol class="items" aria-label="Run results">
        {#each runner.items as i, index (index)}
          <li>
            <button
              class="row {i.state}"
              class:selected={selected === index}
              aria-current={selected === index}
              disabled={!i.response && !i.error}
              onclick={() => (selected = index)}
            >
              <span class="state" data-state={i.state} role="img" aria-label={STATE_LABEL[i.state]}>
                {#if i.state === "sending"}<span class="spinner"></span>
                {:else if i.state === "passed"}<Icon name="check" size={12} />
                {:else if i.state === "failed"}<Icon name="x" size={12} />
                {:else if i.state === "cancelled" || i.state === "notRun"}<Icon name="minus" size={12} />
                {/if}
              </span>
              <Badge method={i.method} />
              <span class="name">{i.name}</span>
              {#if i.unsaved}<span class="unsaved" use:tooltip={"Sent from its open tab's unsaved edits"}>unsaved</span>{/if}
              <span class="spacer"></span>
              {#if i.response}
                <span class="tests muted">{tests(i)}</span>
                <Badge status={i.response.status}>{i.response.status}</Badge>
                <span class="time muted">{formatDuration(i.response.timeMs)}</span>
              {:else if i.error}
                <Badge tone="danger">Error</Badge>
              {:else}
                <span class="muted">{STATE_LABEL[i.state]}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ol>
      <div class="result">
        {#if opened && selected !== null}
          {#key `${runner.runId}:${selected}`}
            <ResponseViewer result={{ id: `run:${runner.runId}:${selected}`, run: { runId: runner.runId, loading: false, startedAt: 0, response: opened.response, error: opened.error } }} />
          {/key}
        {:else}
          <div class="empty-state muted small">Select a result to open it.</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .runner {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 2px 10px 2px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex: none;
  }
  .title {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    width: 46%;
    min-width: 280px;
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 12px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .row:disabled {
    cursor: default;
  }
  .row:not(:disabled):hover {
    background: var(--hover);
  }
  .row.selected {
    background: var(--accent-soft);
  }
  .row.notRun .name,
  .row.cancelled .name,
  .row.queued .name {
    color: var(--muted);
  }
  .state {
    display: inline-flex;
    width: 14px;
    justify-content: center;
    flex: none;
  }
  .state[data-state="passed"] {
    color: var(--success);
  }
  .state[data-state="failed"] {
    color: var(--danger);
  }
  .state[data-state="cancelled"],
  .state[data-state="notRun"] {
    color: var(--muted);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unsaved {
    font-size: 11px;
    color: var(--warning);
  }
  .tests,
  .time {
    font-size: 11.5px;
    white-space: nowrap;
  }
  .time {
    font-family: var(--mono);
  }
  .result {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .small {
    font-size: 12px;
  }
  .spinner {
    width: 11px;
    height: 11px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
