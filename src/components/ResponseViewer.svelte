<script module lang="ts">
  import { newResponseView, type ResponseView } from "../lib/tabView";
  /** A tab's response view lives with the tab (part of the Layout). A Runner result has no
   *  tab, so its view is kept here, by result, in memory only. */
  const resultViews = new Map<string, ResponseView>();
  /** The JSONPath filter, by tab or result, in memory only: it isn't part of the Layout. */
  const filters = new Map<string, string>();
  /** Above this many body bytes, copying a binary body as base64 asks first. */
  const BASE64_COPY_CONFIRM_BYTES = 1024 * 1024;
</script>

<script lang="ts">
  // The response pane: the status bar (status, time, size, Copy and Save), the
  // send error or warnings, and the tabs. Each tab is its own panel; the Body
  // tab's state lives in a BodyView so it outlives a switch to another tab.
  import { untrack } from "svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import { app, CANCEL, type RunState, type Tab } from "../lib/store.svelte";
  import { api, errorMessage } from "../lib/api";
  import { formatBytes, formatDuration } from "../lib/http";
  import { explainStatus } from "../lib/status";
  import { BodyView, saveName } from "../lib/bodyView.svelte";
  import Badge from "./Badge.svelte";
  import Banner from "./Banner.svelte";
  import SendErrorPanel from "./SendErrorPanel.svelte";
  import BodyPanel from "./BodyPanel.svelte";
  import HeadersPanel from "./HeadersPanel.svelte";
  import CookiesPanel from "./CookiesPanel.svelte";
  import TimingPanel from "./TimingPanel.svelte";
  import TestsPanel from "./TestsPanel.svelte";
  import RequestPanel from "./RequestPanel.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shortcutHint } from "../lib/commands";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import RequestHistory from "./RequestHistory.svelte";
  import Self from "./ResponseViewer.svelte";
  import { sentAt, TRUNCATED_AT_CAP } from "../lib/history.svelte";

  // A tab's response (its latest send), or a run's `result` (the Runner panel), which
  // has no tab to cancel or retry in. `result.id` stands in for the tab id that
  // remembers the viewer's choices and keeps the body's documents.
  let { tab, result }: { tab: Tab; result?: never } | { tab?: never; result: { id: string; run: RunState } } = $props();
  const viewId = untrack(() => tab?.id ?? result!.id);

  const run = $derived(tab ? app.runs[tab.id] : result?.run);
  const res = $derived(run?.response);
  /** A History entry's binary body over the cap: only its headers and size were kept. */
  const noBody = $derived(run?.bodyKept === "headersOnly");
  /** What the warning banner says: the response's warnings, then how its body was cut off. */
  const warnings = $derived(
    res
      ? [
          ...res.warnings,
          ...(run?.bodyKept === "truncated" ? [TRUNCATED_AT_CAP] : []),
          ...(res.truncated ? ["Body truncated at the configured size limit (save to keep the received part)."] : []),
        ]
      : [],
  );

  // An editor tab's pane can show its request's History instead, and an entry opened
  // from it, read-only, in a viewer of its own (not a Run's result or a pseudo tab's).
  const historyTab = $derived(tab && app.tabs.some((t) => t.id === tab.id) ? tab : null);
  const showingHistory = $derived(!!historyTab && app.history.isShown(historyTab.id));
  const openedEntry = $derived(historyTab && showingHistory ? app.history.openedIn(historyTab.id) : undefined);

  // The viewer tab, body mode and wrap: the tab's own, or this result's.
  const resultView = $state(untrack(() => (tab ? null : (resultViews.get(viewId) ?? newResponseView()))));
  if (resultView) resultViews.set(viewId, resultView);
  const view = $derived(tab ? tab.responseView : resultView!);
  let filter = $state(untrack(() => filters.get(viewId)) ?? "");
  $effect(() => {
    filters.set(viewId, filter);
  });

  const body = new BodyView(() => ({ tabId: viewId, res, mode: view.mode, filter }));
  const isBinary = $derived(body.isBinary);
  const filtered = $derived(body.filtered);

  // Elapsed time while loading.
  let now = $state(performance.now());
  $effect(() => {
    if (!run?.loading) return;
    const t = setInterval(() => (now = performance.now()), 100);
    return () => clearInterval(t);
  });

  async function copyBody() {
    if (!res) return;
    if (filtered) {
      await navigator.clipboard.writeText(filtered.text);
      app.toast("success", "Filter matches copied");
      return;
    }
    // The shell copies the body itself, so the webview never holds it.
    const binary = isBinary;
    if (binary && res.bodySize > BASE64_COPY_CONFIRM_BYTES) {
      const base64Size = 4 * Math.ceil(res.bodySize / 3);
      const message = `The body is ${formatBytes(res.bodySize)}, which is ${formatBytes(base64Size)} of text as base64. Copy it to the clipboard?`;
      const r = await app.choose("Copy as base64?", message, [
        CANCEL,
        { label: "Copy", value: "copy", role: "primary" },
      ]);
      if (r.button !== "copy") return;
    }
    try {
      await api.copyResponseBody(res.id);
      app.toast("success", binary ? "Response body copied as base64" : "Response body copied");
    } catch (e) {
      app.toast("error", errorMessage(e));
    }
  }

  async function saveBody() {
    if (!res) return;
    const path = await save({ defaultPath: saveName(res) });
    if (!path) return;
    try {
      await api.saveResponseBody(res.id, path);
      app.toast("success", `Saved to ${path}`);
    } catch (e) {
      app.toast("error", errorMessage(e));
    }
  }

  // The viewer's tabs. Adding one is a line here plus its panel below. A
  // `count` shows after the label; leave it out for none, and pass 0 only where
  // an empty tab says something (no headers at all is worth knowing).
  const tabs = $derived<SegmentedOption[]>([
    { value: "body", label: "Body" },
    { value: "headers", label: "Headers", count: res?.headers.length ?? 0 },
    // Always there, so the tabs don't shift; counted only when there are cookies.
    { value: "cookies", label: "Cookies", count: res?.cookies.length || undefined },
    { value: "timing", label: "Timing" },
    { value: "request", label: "Request" },
    // Only when the response's scripts reported or logged something.
    ...(res?.tests?.length || res?.logs?.length ? [{ value: "tests", label: "Tests", count: res.tests.length || undefined }] : []),
  ]);
  // A remembered tab that this response doesn't have falls back to Body.
  const current = $derived(tabs.some((t) => t.value === view.tab) ? view.tab : "body");

  const statusTooltip = $derived(res ? `${explainStatus(res.status, res.statusText)}\n${res.httpVersion} · final URL ${res.url}` : "");
  const sizeTooltip = $derived.by(() => {
    if (!res) return "";
    const headers = `Headers ${formatBytes(res.headersSize)}`;
    if (!res.contentEncoding) return `Body ${formatBytes(res.bodySize)} · ${headers}`;
    return `Transferred ${formatBytes(res.transferredSize)} (${res.contentEncoding}) · Decoded ${formatBytes(res.bodySize)} · ${headers}`;
  });
  const timeTooltip = $derived(res ? `Time to first byte ${formatDuration(res.ttfbMs)} · Download ${formatDuration(res.timeMs - res.ttfbMs)}` : "");
</script>

{#snippet historySwitch(t: Tab)}
  <button class="btn small ghost history-switch" class:on={showingHistory} aria-pressed={showingHistory} onclick={() => app.history.toggle(t.id)}>History</button>
{/snippet}

{#snippet fromHistory()}
  {#if run?.fromHistory}
    <span class="muted small" use:tooltip={"The last response recorded in History, not sent in this Session: Request variables reading it count it unsent"}>from History, {sentAt(run.fromHistory)}</span>
  {/if}
{/snippet}

<div class="viewer">
  {#if historyTab && showingHistory}
    <div class="statusbar">
      {#if openedEntry}
        <button class="btn small ghost" aria-label="Back to History" use:tooltip={"Back to the list"} onclick={() => app.history.close(historyTab.id)}><Icon name="chevron-left" />Back</button>
        <span class="muted small">Sent {sentAt(openedEntry.entry.time)} · read-only</span>
        <button class="btn small ghost" use:tooltip={"Edit the request as it was written when sent, unsaved"} onclick={() => app.restoreRequest(historyTab.path, historyTab.key, openedEntry.source)}>Restore request</button>
      {:else}
        <span class="title">History</span>
      {/if}
      {@render historySwitch(historyTab)}
    </div>
    {#if openedEntry}
      <section class="entry" aria-label="History entry">
        {#key openedEntry.tab.id}<Self tab={openedEntry.tab} />{/key}
      </section>
    {:else}
      <RequestHistory tab={historyTab} />
    {/if}
  {:else if !run}
    {#if historyTab}
      <div class="statusbar">
        <span class="title">Response</span>
        {@render historySwitch(historyTab)}
      </div>
    {/if}
    <div class="empty-state">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
        <rect x="10" y="14" width="52" height="44" rx="6" stroke="var(--border-strong)" stroke-width="2" />
        <path d="M10 24h52" stroke="var(--border-strong)" stroke-width="2" />
        <path d="M22 36l6 5-6 5M34 46h14" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div>Click <strong>Send</strong> to get a response</div>
      <div class="muted small"><kbd>{shortcutHint("send")}</kbd></div>
    </div>
  {:else}
    <div class="statusbar">
      <span class="title">Response</span>
      {#if run.loading}
        <span class="loading">
          <span class="spinner"></span>Sending… {formatDuration(now - run.startedAt)}
          {#if run.received !== undefined}<span class="received">{formatBytes(run.received)} received</span>{/if}
        </span>
        <span class="spacer"></span>
        {#if tab}<button class="btn small" onclick={() => app.cancel(tab.id)}>Cancel</button>{/if}
      {:else if run.cancelled && !res}
        <Badge size="md">Cancelled</Badge>
        {@render fromHistory()}
      {:else if res}
        {#if run.cancelled}<span class="tip" use:tooltip={"The last send was cancelled; this is the response before it"}><Badge size="md">Cancelled</Badge></span>{/if}
        <span class="tip" use:tooltip={statusTooltip}><Badge size="md" status={res.status}>{res.status} {res.statusText}</Badge></span>
        <span class="metric" use:tooltip={timeTooltip}><span class="muted">Time</span> {formatDuration(res.timeMs)}</span>
        <span class="metric" use:tooltip={sizeTooltip}><span class="muted">Size</span> {formatBytes(res.bodySize + res.headersSize)}</span>
        {@render fromHistory()}
        <span class="spacer"></span>
        {#if !noBody}
        <button class="icon-btn" aria-label="Copy body" use:tooltip={filtered ? "Copy the filter's matches" : isBinary ? "Copy body as base64" : "Copy body"} onclick={copyBody}><Icon name="copy" /></button>
        <button class="icon-btn" aria-label="Save body to file" use:tooltip={filtered ? "Save the full body to a file" : "Save body to file"} onclick={saveBody}><Icon name="download" /></button>
        {/if}
      {:else if run.error}
        <Badge size="md" tone="danger">Error</Badge>
        {@render fromHistory()}
      {/if}
      {#if historyTab}{@render historySwitch(historyTab)}{/if}
    </div>

    {#if run.cancelled && !res}
      <div class="empty-state small">Request cancelled.</div>
    {:else if run.error && !run.loading}
      <SendErrorPanel error={run.error} tabId={tab?.id} onretry={tab && (() => app.send(tab.id))} />
    {:else if res}
      {#if warnings.length}
        <Banner severity="warning">
          <span class="selectable">{warnings.join(" · ")}</span>
        </Banner>
      {/if}
      <div class="tabs">
        <SegmentedControl label="Response tabs" options={tabs} value={current} onchange={(t) => (view.tab = t)} />
      </div>

      {#if current === "body" && noBody}
        <div class="empty-state small">Not kept: History keeps only the headers and size of a binary body over 10 MB.</div>
      {:else if current === "body"}
        <BodyPanel {res} view={body} bind:mode={view.mode} bind:wrap={view.wrap} bind:filter />
      {:else if current === "headers"}
        <HeadersPanel headers={res.headers} />
      {:else if current === "cookies"}
        <CookiesPanel cookies={res.cookies} url={res.url} />
      {:else if current === "timing"}
        <TimingPanel {res} />
      {:else if current === "tests"}
        <TestsPanel tests={res.tests} logs={res.logs ?? []} />
      {:else}
        <RequestPanel {res} />
      {/if}
    {/if}
  {/if}
</div>

<style>
  .viewer {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .small {
    font-size: 12px;
  }
  .statusbar {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 40px;
    padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title {
    font-weight: 600;
    font-size: 12.5px;
  }
  /* Holds a badge's tooltip. */
  .tip {
    display: flex;
  }
  .metric {
    font-size: 12px;
    font-family: var(--mono);
  }
  .metric .muted {
    font-family: var(--font);
    margin-right: 3px;
  }
  .loading {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .received {
    font-family: var(--mono);
  }
  .spinner {
    width: 13px;
    height: 13px;
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
  .viewer :global(.send-error) {
    margin: 18px;
  }
  .tabs {
    display: flex;
    padding: 6px 10px 6px 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  /* The view switch sits at the end of the title row, whatever comes before it. */
  .history-switch {
    margin-left: auto;
  }
  .entry {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
