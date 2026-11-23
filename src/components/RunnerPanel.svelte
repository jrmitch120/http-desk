<!--
  The Runner panel (in the panel area, PanelArea.svelte): the last run (`app.runner`)
  live, one row per request with its state, status, time and tests, Stop while it
  runs, and Re-run failed and Export once it's done. Selecting a row opens its result in the
  response viewer beside the list; a run never touches what the tabs show. Its
  options (a delay, stop on first failure) are the workspace's, for the next run.
-->
<script lang="ts">
  import { app, type RunItem } from "../lib/store.svelte";
  import { formatDuration, relativePath } from "../lib/http";
  import { menu } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { rovingList } from "../lib/rovingList";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";
  import NumberField from "./NumberField.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";
  import Toggle from "./Toggle.svelte";

  const runner = $derived(app.runner);
  const options = $derived(app.runnerOptions);
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

  /** The run's items by file, in run order (a run sends each file's requests together). */
  const groups = $derived.by(() => {
    const out: { path: string; file: string; items: { item: RunItem; index: number }[] }[] = [];
    runner?.items.forEach((item, index) => {
      const last = out.at(-1);
      if (last?.path === item.path) last.items.push({ item, index });
      else out.push({ path: item.path, file: app.root ? relativePath(app.root, item.path).replace(/^\.\//, "") : item.path, items: [{ item, index }] });
    });
    return out;
  });

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

  // Export, once the run has ended: its results as JUnit XML or JSON.
  let exportButton = $state<HTMLButtonElement>();
  function exportMenu(e: MouseEvent) {
    if (menu.isOpenFrom(exportButton)) return menu.close(false);
    menu.show(
      e,
      [
        { label: "JUnit XML…", action: () => app.exportRun("junit") },
        { label: "JSON…", action: () => app.exportRun("json") },
      ],
      { anchor: exportButton, align: "end", label: "Export" },
    );
  }

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
      <span class="muted">Run a file or folder from its menu in the explorer, or select requests there and run the selection from their menu.</span>
    {/if}
    <span class="spacer"></span>
    {#if runner?.running}
      <button class="btn small" onclick={() => app.stopRun()}><Icon name="stop" />Stop</button>
    {:else}
      {#if app.canRerunFailed}
        <button class="btn small" onclick={() => app.rerunFailed()}><Icon name="refresh" />Re-run failed</button>
      {/if}
      {#if runner?.results}
        <button
          bind:this={exportButton}
          class="btn small ghost"
          aria-haspopup="menu"
          aria-expanded={menu.isOpenFrom(exportButton)}
          use:tooltip={"Save the results as JUnit XML or JSON"}
          onclick={exportMenu}><Icon name="download" />Export</button
        >
      {/if}
    {/if}
    <div class="options" role="group" aria-label="Runner options">
      <span class="option">
        <span class="muted">Delay</span>
        <NumberField label="Delay between requests" unit="ms" integer min={0} value={options.delayMs} onchange={(delayMs) => app.setRunnerOptions({ delayMs })} />
      </span>
      <Toggle
        label="Stop on first failure"
        title={options.stopOnFailure ? "A failure ends the run — click to run every request" : "Every request runs — click to end a run at its first failure"}
        checked={options.stopOnFailure}
        onchange={(stopOnFailure) => app.setRunnerOptions({ stopOnFailure })}
      />
    </div>
  </div>
  {#if runner}
    <div class="body">
      <!-- Every file's results move as one list (rovingList): one Tab stop; rows with nothing to show yet are skipped. -->
      <div class="items" use:rovingList={{ activate: (row) => row.click() }}>
        {#each groups as g, gi (gi)}
          <div class="group" role="group" aria-label={g.file}>
            <div class="file selectable" aria-hidden="true"><Icon name="file" size={12} /><span class="name">{g.file}</span></div>
            <div role="list" aria-label={g.file}>
              {#each g.items as { item: i, index } (index)}
                {@const waiting = !i.response && !i.error}
                <!-- The list's keys are rovingList's: Enter clicks the row. A waiting row is aria-disabled, which is how
                     rovingList skips it (and how a screen reader hears it can't open yet); it takes no focus from a click either. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_role_supports_aria_props -->
                <div
                  role="listitem"
                  tabindex="-1"
                  class="list-row row {i.state}"
                  class:selected={selected === index}
                  aria-current={selected === index}
                  aria-disabled={waiting}
                  onmousedown={(e) => waiting && e.preventDefault()}
                  onclick={() => !waiting && (selected = index)}
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
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
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
  .options {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .option {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  /* As wide as its input and unit: a narrower box lets them spill left over the label. */
  .option :global(.number-field) {
    flex: none;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .items {
    padding: 4px 0;
    width: 46%;
    min-width: 280px;
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  .group + .group {
    margin-top: 4px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px 2px;
    font-size: 11.5px;
    color: var(--muted);
  }
  /* A `.list-row` (its hover and focus ring), in the text colour, with no edge: the
     open result is a selection, filled. */
  .row {
    padding: var(--space-1) var(--space-3);
    border-left: 0;
    color: var(--text);
  }
  .row[aria-disabled="true"] {
    cursor: default;
    background-image: none;
  }
  .row.selected {
    background-color: var(--accent-soft);
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
  /* As wide as "999 ms" and "12.34 s" (monospace), so every row's status and time line up. */
  .time {
    font-family: var(--mono);
    min-width: 7ch;
    text-align: right;
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
