<script module lang="ts">
  type BodyView = "pretty" | "raw" | "preview";
  const viewByTab = new Map<string, { tab: string; mode: BodyView; wrap: boolean }>();
  /** Above this many body bytes, copying a binary body as base64 asks first. */
  const BASE64_COPY_CONFIRM_BYTES = 1024 * 1024;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import { app, type Tab } from "../lib/store.svelte";
  import { api, errorMessage } from "../lib/api";
  import { formatBytes, formatDuration, prettyXml } from "../lib/http";
  import { explainStatus } from "../lib/status";
  import { formatPhase, redirectNote, timingPhases } from "../lib/timing";
  import Editor from "../lib/codemirror/Editor.svelte";
  import type { Language } from "../lib/codemirror/setup";
  import Badge from "./Badge.svelte";
  import Banner from "./Banner.svelte";
  import HeadersPanel from "./HeadersPanel.svelte";
  import TimingPanel from "./TimingPanel.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";

  let { tab }: { tab: Tab } = $props();

  const run = $derived(app.runs[tab.id]);
  const res = $derived(run?.response);

  const saved = untrack(() => viewByTab.get(tab.id));
  let view = $state(saved?.tab ?? "body");
  let mode = $state<BodyView>(saved?.mode ?? "pretty");
  let wrap = $state(saved?.wrap ?? false);
  let editor: Editor | undefined = $state();
  $effect(() => {
    viewByTab.set(tab.id, { tab: view, mode, wrap });
  });

  // Elapsed time while loading.
  let now = $state(performance.now());
  $effect(() => {
    if (!run?.loading) return;
    const t = setInterval(() => (now = performance.now()), 100);
    return () => clearInterval(t);
  });

  const ct = $derived((res?.contentType ?? "").toLowerCase());
  const kind = $derived.by(() => {
    if (!res) return "none";
    if (ct.includes("json")) return "json";
    if (ct.includes("html")) return "html";
    if (ct.includes("xml") || ct.includes("svg")) return "xml";
    if (ct.startsWith("image/")) return "image";
    if (ct.includes("pdf")) return "pdf";
    if (ct.startsWith("audio/") || ct.startsWith("video/")) return "media";
    if (res.bodyText !== null) {
      const t = res.bodyText.trimStart();
      if (t.startsWith("{") || t.startsWith("[")) return "json";
      if (t.startsWith("<")) return "xml";
      return "text";
    }
    return "binary";
  });
  const canPreview = $derived(["html", "image", "pdf", "media"].includes(kind));
  const isBinary = $derived(!!res && res.bodyText === null);

  const effectiveMode = $derived<BodyView>(isBinary ? (canPreview && mode !== "raw" ? "preview" : "raw") : mode === "preview" && !canPreview ? "pretty" : mode);
  const viewOptions = $derived<SegmentedOption<BodyView>[]>([
    ...(isBinary ? [] : [{ value: "pretty" as const, label: "Pretty" }]),
    { value: "raw", label: isBinary ? "Hex" : "Raw" },
    ...(canPreview ? [{ value: "preview" as const, label: "Preview" }] : []),
  ]);

  const language = $derived<Language>(kind === "json" ? "json" : kind === "xml" ? "xml" : kind === "html" ? "html" : "text");

  // Pretty JSON comes from the core (lossless: numbers stay as the server sent
  // them), once per response. Raw text shows until it arrives, and stays if
  // the body isn't valid JSON.
  let formatted = $state<{ id: string; text: string } | null>(null);
  $effect(() => {
    if (!res || res.bodyText === null || kind !== "json" || effectiveMode !== "pretty") return;
    const { id, bodyText: raw } = res;
    if (untrack(() => formatted?.id) === id) return;
    const keep = (text: string) => {
      if (res?.id === id) formatted = { id, text }; // a newer response may have arrived
    };
    api.formatBody(raw, "json", "pretty").then(keep, () => keep(raw));
  });

  const bodyText = $derived.by(() => {
    if (!res) return "";
    if (res.bodyText === null) return hexdump(res.bodyBase64);
    if (effectiveMode !== "pretty") return res.bodyText;
    if (kind === "json") return formatted?.id === res.id ? formatted.text : res.bodyText;
    if (kind === "xml" && res.bodyText.length < 5_000_000) return prettyXml(res.bodyText);
    return res.bodyText;
  });

  const dataUrl = $derived(res?.bodyBase64 ? `data:${res.contentType ?? "application/octet-stream"};base64,${res.bodyBase64}` : null);

  function hexdump(b64: string | null): string {
    if (!b64) return "(binary content too large to preview — use Save to write it to a file)";
    const bin = atob(b64.slice(0, 87384)); // ~64 KB
    const lines: string[] = [];
    for (let off = 0; off < bin.length; off += 16) {
      const chunk = bin.slice(off, off + 16);
      const hex = [...chunk].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
      const ascii = [...chunk].map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127 ? c : ".")).join("");
      lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
    }
    if (b64.length > 87384) lines.push("… (truncated preview)");
    return lines.join("\n");
  }

  async function copyBody() {
    if (!res) return;
    if (res.bodyText !== null) {
      await navigator.clipboard.writeText(res.bodyText);
      app.toast("success", "Response body copied");
      return;
    }
    const b64 = res.bodyBase64;
    if (!b64) return;
    const bytes = base64Bytes(b64);
    if (bytes > BASE64_COPY_CONFIRM_BYTES) {
      const message = `The body is ${formatBytes(bytes)}, which is ${formatBytes(b64.length)} of text as base64. Copy it to the clipboard?`;
      const r = await app.choose("Copy as base64?", message, [
        { label: "Cancel", value: "cancel" },
        { label: "Copy", value: "copy", primary: true },
      ]);
      if (r.button !== "copy") return;
    }
    await navigator.clipboard.writeText(b64);
    app.toast("success", "Response body copied as base64");
  }

  /** How many bytes a base64 string decodes to, without decoding it. */
  function base64Bytes(b64: string): number {
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
  }

  async function saveBody() {
    if (!res) return;
    const ext = kind === "json" ? "json" : kind === "xml" ? "xml" : kind === "html" ? "html" : (ct.split("/")[1]?.split(";")[0] ?? "bin");
    const path = await save({ defaultPath: `response.${ext}` });
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
    { value: "timing", label: "Timing" },
    { value: "request", label: "Request" },
  ]);
  // A remembered tab that this response doesn't have falls back to Body.
  const current = $derived(tabs.some((t) => t.value === view) ? view : "body");

  const statusTitle = $derived(res ? `${explainStatus(res.status, res.statusText)}\n${res.httpVersion} · final URL ${res.url}` : "");
  const sizeTitle = $derived.by(() => {
    if (!res) return "";
    const headers = `Headers ${formatBytes(res.headersSize)}`;
    if (!res.contentEncoding) return `Body ${formatBytes(res.bodySize)} · ${headers}`;
    return `Transferred ${formatBytes(res.transferredSize)} (${res.contentEncoding}) · Decoded ${formatBytes(res.bodySize)} · ${headers}`;
  });
  const timeTitle = $derived(res ? `Time to first byte ${formatDuration(res.ttfbMs)} · Download ${formatDuration(res.timeMs - res.ttfbMs)}` : "");
</script>

<div class="viewer">
  {#if !run}
    <div class="empty-state">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
        <rect x="10" y="14" width="52" height="44" rx="6" stroke="var(--border-strong)" stroke-width="2" />
        <path d="M10 24h52" stroke="var(--border-strong)" stroke-width="2" />
        <path d="M22 36l6 5-6 5M34 46h14" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div>Click <strong>Send</strong> to get a response</div>
      <div class="muted small"><kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd></div>
    </div>
  {:else}
    <div class="statusbar">
      <span class="title">Response</span>
      {#if run.loading}
        <span class="loading"><span class="spinner"></span>Sending… {formatDuration(now - run.startedAt)}</span>
        <span class="spacer"></span>
        <button class="btn small" onclick={() => app.cancel(tab.id)}>Cancel</button>
      {:else if run.cancelled && !res}
        <Badge size="md">Cancelled</Badge>
      {:else if res}
        {#if run.cancelled}<span class="tip" use:tooltip={"The last send was cancelled; this is the response before it"}><Badge size="md">Cancelled</Badge></span>{/if}
        <span class="tip" use:tooltip={statusTitle}><Badge size="md" status={res.status}>{res.status} {res.statusText}</Badge></span>
        <span class="metric" use:tooltip={timeTitle}><span class="muted">Time</span> {formatDuration(res.timeMs)}</span>
        <span class="metric" use:tooltip={sizeTitle}><span class="muted">Size</span> {formatBytes(res.bodySize + res.headersSize)}</span>
        <span class="spacer"></span>
        <button class="icon-btn" aria-label="Copy body" use:tooltip={isBinary ? "Copy body as base64" : "Copy body"} disabled={isBinary && !res.bodyBase64} onclick={copyBody}><Icon name="copy" /></button>
        <button class="icon-btn" aria-label="Save body to file" use:tooltip onclick={saveBody}><Icon name="download" /></button>
      {:else if run.error}
        <Badge size="md" tone="danger">Error</Badge>
      {/if}
    </div>

    {#if run.cancelled && !res}
      <div class="empty-state small">Request cancelled.</div>
    {:else if run.error && !run.loading}
      <Banner severity="error" inline heading="Could not send request" class="send-error">
        <div class="err-msg selectable mono">{run.error}</div>
        <div class="muted">Check the URL, the selected environment, and that the server is reachable.</div>
      </Banner>
    {:else if res}
      {#if res.warnings.length || res.truncated}
        <Banner severity="warning">
          <span class="selectable">{[...res.warnings, ...(res.truncated ? ["Body truncated at the configured size limit (save to keep the received part)."] : [])].join(" · ")}</span>
        </Banner>
      {/if}
      <div class="tabs">
        <SegmentedControl label="Response tabs" options={tabs} value={current} onchange={(t) => (view = t)} />
      </div>

      {#if current === "body"}
        <div class="toolbar">
          <SegmentedControl label="Response view" options={viewOptions} value={effectiveMode} onchange={(m) => (mode = m)} />
          {#if !isBinary}<span class="lang muted">{kind.toUpperCase()}</span>{/if}
          <span class="spacer"></span>
          {#if effectiveMode !== "preview"}
            <button class="icon-btn" aria-label="Search" use:tooltip={"Search (⌘/Ctrl F)"} onclick={() => editor?.openSearch()}><Icon name="search" size={14} /></button>
            {#if kind === "json" || kind === "xml"}
              <button class="icon-btn" aria-label="Fold all" use:tooltip onclick={() => editor?.fold(true)}><Icon name="fold" size={14} /></button>
              <button class="icon-btn" aria-label="Unfold all" use:tooltip onclick={() => editor?.fold(false)}><Icon name="unfold" size={14} /></button>
            {/if}
            <button class="icon-btn" class:active={wrap} aria-label="Wrap lines" use:tooltip onclick={() => (wrap = !wrap)}><Icon name="wrap" size={14} /></button>
          {/if}
        </div>
        <div class="body">
          {#if effectiveMode === "preview" && dataUrl}
            {#if kind === "image"}
              <div class="preview-img"><img src={dataUrl} alt="Response preview" /></div>
            {:else if kind === "html"}
              <iframe title="HTML preview" sandbox="" srcdoc={res.bodyText ?? ""}></iframe>
            {:else if kind === "pdf"}
              <iframe title="PDF preview" src={dataUrl}></iframe>
            {:else if kind === "media"}
              <div class="preview-img">
                {#if ct.startsWith("audio/")}<audio controls src={dataUrl}></audio>{:else}<video controls src={dataUrl}><track kind="captions" /></video>{/if}
              </div>
            {/if}
          {:else if effectiveMode === "preview" && kind === "html"}
            <iframe title="HTML preview" sandbox="" srcdoc={res.bodyText ?? ""}></iframe>
          {:else if res.bodySize === 0}
            <div class="empty-state small">The response has no body.</div>
          {:else}
            <Editor bind:this={editor} value={bodyText} readonly {wrap} language={isBinary ? "text" : language} />
          {/if}
        </div>
      {:else if current === "headers"}
        <HeadersPanel headers={res.headers} />
      {:else if current === "timing"}
        <TimingPanel {res} />
      {:else}
        <div class="table-wrap">
          <div class="sent-line selectable mono"><strong>{res.request.method}</strong> {res.request.url}</div>
          <table>
            <tbody>
              {#each res.request.headers as [k, v], i (i)}
                <tr><td class="k">{k}</td><td class="v selectable">{k.toLowerCase() === "authorization" ? v.replace(/^(\S+\s+).+$/, "$1••••••••") : v}</td></tr>
              {/each}
            </tbody>
          </table>
          {#if res.request.bodyPreview !== null}
            <div class="sent-body-title muted">Body · {formatBytes(res.request.bodySize)}</div>
            <pre class="sent-body selectable mono">{res.request.bodyPreview}</pre>
          {/if}
          <div class="sent-body-title muted">Timing · {formatDuration(res.timeMs)} total{res.timings.redirects ? `, ${redirectNote(res.timings.redirects)}` : ""}</div>
          <div class="sent-timing selectable mono">
            {timingPhases(res).map((p) => `${p.label} ${formatPhase(p.ms)}`).join(" · ")}{res.timings.reused ? " · reused connection" : ""}
          </div>
          <p class="muted small">
            A reconstruction of the final request from what HttpDesk prepared, not the bytes on the wire. Disabled components and unresolved sections are not included.
            {#if res.timings.redirects}It ended at {res.url}; later hops may differ in method and headers.{/if}
          </p>
        </div>
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
  .err-msg {
    color: var(--text);
    margin: 4px 0 6px;
    word-break: break-word;
  }
  .tabs {
    display: flex;
    padding: 6px 10px 6px 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 6px 16px;
    flex: none;
  }
  .lang {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .body {
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .body > :global(*) {
    flex: 1;
  }
  iframe {
    border: none;
    width: 100%;
    height: 100%;
    background: #fff;
  }
  .preview-img {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
    background: repeating-conic-gradient(var(--panel-2) 0 25%, var(--panel) 0 50%) 0 0 / 16px 16px;
  }
  .preview-img img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .table-wrap {
    flex: 1;
    overflow: auto;
    padding: 8px 16px 16px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .k {
    font-weight: 600;
    white-space: nowrap;
    width: 1%;
    padding-right: 24px;
    color: var(--text-2);
  }
  .v {
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .sent-line {
    padding: 8px;
    font-size: 12.5px;
    word-break: break-all;
  }
  .sent-body-title {
    margin: 14px 8px 6px;
    font-size: 12px;
  }
  .sent-timing {
    padding: 0 8px;
    font-size: 12px;
  }
  .sent-body {
    margin: 0;
    padding: 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 320px;
    overflow: auto;
  }
</style>
