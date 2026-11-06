<script lang="ts">
  // OpenAPI → .http generation wizard: pick a spec, select operations, generate.
  import { open } from "@tauri-apps/plugin-dialog";
  import { SvelteSet } from "svelte/reactivity";
  import { api, errorMessage } from "../lib/api";
  import { joinPath, methodClass, slugify } from "../lib/http";
  import { app } from "../lib/store.svelte";
  import type { Grouping, OperationInfo, SpecSummary } from "../lib/types";
  import Checkbox from "./Checkbox.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import Toggle from "./Toggle.svelte";

  let step = $state<"source" | "select">("source");
  let kind = $state<"file" | "url">("file");
  let filePath = $state("");
  let url = $state("");
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let source = $state("");
  let summary = $state<SpecSummary | null>(null);
  const selected = new SvelteSet<string>();
  let collapsed = $state<Record<string, boolean>>({});
  let filter = $state("");
  let showWarnings = $state(false);

  let grouping = $state<Grouping>("tag");
  let baseUrlVariable = $state("baseUrl");
  let paramDescriptions = $state(true);
  let outputDir = $state("");
  let generating = $state(false);

  const groupOf = (op: OperationInfo) => op.tags[0] ?? "default";
  const segmentOf = (op: OperationInfo) => op.path.split("/").filter(Boolean)[0]?.replace(/[{}]/g, "") || "root";

  const groups = $derived.by(() => {
    const map = new Map<string, OperationInfo[]>();
    for (const op of summary?.operations ?? []) {
      const g = groupOf(op);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(op);
    }
    return [...map].map(([name, ops]) => ({ name, ops }));
  });

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    const match = (op: OperationInfo) =>
      [op.path, op.method, op.summary ?? "", op.operationId ?? "", ...op.tags].some((s) => s.toLowerCase().includes(q));
    return groups.map((g) => ({ name: g.name, ops: g.ops.filter(match) })).filter((g) => g.ops.length);
  });

  const total = $derived(summary?.operations.length ?? 0);
  const allSelected = $derived(total > 0 && selected.size === total);

  const fileCount = $derived.by(() => {
    const ops = (summary?.operations ?? []).filter((o) => selected.has(o.id));
    if (!ops.length) return 0;
    if (grouping === "single") return 1;
    return new Set(ops.map(grouping === "tag" ? groupOf : segmentOf)).size;
  });

  async function browseSpec() {
    const picked = await open({ multiple: false, filters: [{ name: "OpenAPI", extensions: ["yaml", "yml", "json"] }] });
    if (typeof picked === "string") filePath = picked;
  }

  async function browseOutput() {
    const picked = await open({ directory: true, defaultPath: outputDir || app.root || undefined });
    if (typeof picked === "string") outputDir = picked;
  }

  async function load() {
    const src = (kind === "file" ? filePath : url).trim();
    if (!src) return;
    loading = true;
    loadError = null;
    try {
      const s = await api.openapiLoad(src);
      source = src;
      summary = s;
      selected.clear();
      for (const op of s.operations) selected.add(op.id);
      collapsed = {};
      filter = "";
      if (!outputDir && app.root) outputDir = joinPath(app.root, slugify(s.title));
      step = "select";
    } catch (e) {
      loadError = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  function toggleGroup(ops: OperationInfo[]) {
    const all = ops.every((o) => selected.has(o.id));
    for (const o of ops) all ? selected.delete(o.id) : selected.add(o.id);
  }

  function toggleOp(id: string) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
  }

  function selectAll(on: boolean) {
    selected.clear();
    if (on) for (const op of summary?.operations ?? []) selected.add(op.id);
  }

  async function generate() {
    if (!summary || !selected.size || !outputDir.trim()) return;
    generating = true;
    const dir = outputDir.trim();
    const options = {
      operationIds: allSelected ? [] : summary.operations.filter((o) => selected.has(o.id)).map((o) => o.id),
      grouping,
      baseUrlVariable: baseUrlVariable.trim() || "baseUrl",
      singleFileName: null,
      paramDescriptions,
    };
    try {
      const preview = await api.openapiGenerate({ source, options, outputDir: dir, overwrite: false, dryRun: true });
      const overwrite = preview.conflicts.length > 0;
      if (overwrite && !(await app.confirmOverwrite(preview.conflicts))) return;
      const report = await api.openapiGenerate({ source, options, outputDir: dir, overwrite, dryRun: false });
      if (!report.written) {
        app.toast("error", "Nothing was written — the target files already exist.");
        return;
      }
      await app.refreshTree();
      // Open documents among them (unsaved edits included, as confirmed) now show the new contents.
      await app.reloadOpen(report.files);
      await app.loadEnvironments();
      app.expanded[dir] = true;
      if (!app.envName && report.environments[0]) await app.selectEnvironment(report.environments[0]);
      if (report.files[0]) {
        app.expanded[report.files[0]] = true;
        await app.openRequest(report.files[0], { index: 0 });
      }
      const n = selected.size;
      const envNote = report.environments.length
        ? ` Base URL${report.environments.length > 1 ? "s" : ""} added to environment${report.environments.length > 1 ? "s" : ""} ${report.environments.join(", ")}; credentials go to http-client.private.env.json.`
        : "";
      app.toast("success", `Generated ${n} request${n === 1 ? "" : "s"} in ${report.files.length} file${report.files.length === 1 ? "" : "s"}.${envNote}`);
      if (report.gitignoreUpdated) app.toast("info", "Added http-client.private.env.json to .gitignore");
      if (report.warnings.length) {
        app.toast("info", `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}: ${report.warnings.slice(0, 3).join("; ")}${report.warnings.length > 3 ? "…" : ""}`);
      }
      app.modal = null;
    } catch (e) {
      app.toast("error", `Generation failed: ${errorMessage(e)}`);
    } finally {
      generating = false;
    }
  }

  function close() {
    if (app.dialog) return;
    app.modal = null;
  }
</script>

<Modal title="Import OpenAPI specification" width="900px" height="640px" onclose={close}>
  {#if step === "source"}
    <div class="source">
      <p class="intro muted">
        Generate standard <span class="mono">.http</span> files from an OpenAPI 3.0 or 3.1 specification (JSON or YAML). Requests stay plain, portable text you can edit anywhere.
      </p>
      <div class="seg" role="tablist">
        <button class:on={kind === "file"} onclick={() => (kind = "file")} role="tab" aria-selected={kind === "file"}><Icon name="file" size={14} />File</button>
        <button class:on={kind === "url"} onclick={() => (kind = "url")} role="tab" aria-selected={kind === "url"}><Icon name="globe" size={14} />URL</button>
      </div>
      {#if kind === "file"}
        <label class="field">
          <span>Specification file</span>
          <div class="row">
            <input class="input mono grow" placeholder="/path/to/openapi.yaml" bind:value={filePath} onkeydown={(e) => e.key === "Enter" && load()} />
            <button class="btn" onclick={browseSpec}>Browse…</button>
          </div>
        </label>
      {:else}
        <label class="field">
          <span>Specification URL</span>
          <input class="input mono" placeholder="https://petstore3.swagger.io/api/v3/openapi.json" bind:value={url} onkeydown={(e) => e.key === "Enter" && load()} />
        </label>
      {/if}
      {#if loadError}
        <div class="banner error load-error"><Icon name="alert" /><span class="selectable">{loadError}</span></div>
      {/if}
    </div>
  {:else if summary}
    <div class="select">
      <div class="spec-head">
        <div class="spec-title">
          <strong>{summary.title}</strong>
          <span class="pill">v{summary.version}</span>
          <span class="pill">OpenAPI {summary.openapiVersion}</span>
        </div>
        {#if summary.servers.length}
          <div class="servers muted">
            {#each summary.servers as s (s.url)}
              <span class="mono" title={s.description ?? ""}>{s.url}{#if s.description}<span class="desc">{` — ${s.description}`}</span>{/if}</span>
            {/each}
          </div>
        {/if}
      </div>
      {#if summary.warnings.length}
        <div class="banner warning warn">
          <button class="warn-toggle" onclick={() => (showWarnings = !showWarnings)}>
            <Icon name="alert" />
            {summary.warnings.length} warning{summary.warnings.length === 1 ? "" : "s"} while reading the specification
            <Icon name={showWarnings ? "chevron-down" : "chevron-right"} size={13} />
          </button>
          {#if showWarnings}
            <ul class="selectable">
              {#each summary.warnings as w, i (i)}<li>{w}</li>{/each}
            </ul>
          {/if}
        </div>
      {/if}

      <div class="body">
        <div class="ops">
          <div class="ops-toolbar">
            <div class="filter">
              <Icon name="search" size={13} />
              <input class="input" placeholder="Filter operations" bind:value={filter} />
            </div>
            <div class="spacer"></div>
            <span class="muted small-text">{selected.size} of {total} selected</span>
            <button class="btn small ghost" onclick={() => selectAll(true)} disabled={allSelected}>Select all</button>
            <button class="btn small ghost" onclick={() => selectAll(false)} disabled={!selected.size}>None</button>
          </div>
          <div class="op-list">
            {#each filtered as g (g.name)}
              {@const count = g.ops.filter((o) => selected.has(o.id)).length}
              <div class="group">
                <div class="group-head">
                  <button class="icon-btn" onclick={() => (collapsed[g.name] = !collapsed[g.name])} title={collapsed[g.name] ? "Expand" : "Collapse"}>
                    <Icon name={collapsed[g.name] ? "chevron-right" : "chevron-down"} size={13} />
                  </button>
                  <Checkbox
                    checked={count === g.ops.length}
                    indeterminate={count > 0 && count < g.ops.length}
                    onchange={() => toggleGroup(g.ops)}
                    label="Select all in {g.name}"
                  />
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <span class="group-name" onclick={() => (collapsed[g.name] = !collapsed[g.name])}>{g.name}</span>
                  <span class="muted small-text">{count}/{g.ops.length}</span>
                </div>
                {#if !collapsed[g.name]}
                  {#each g.ops as op (op.id)}
                    <Checkbox class="op{op.deprecated ? ' deprecated' : ''}" checked={selected.has(op.id)} onchange={() => toggleOp(op.id)}>
                      <span class="method-badge {methodClass(op.method)}">{op.method}</span>
                      <span class="path mono ellipsis" title={op.path}>{op.path}</span>
                      <span class="summary muted ellipsis" title={op.summary ?? op.operationId ?? ""}>{op.summary ?? op.operationId ?? ""}</span>
                      {#if op.deprecated}<span class="dep">deprecated</span>{/if}
                    </Checkbox>
                  {/each}
                {/if}
              </div>
            {:else}
              <div class="empty-state">No operations match “{filter}”.</div>
            {/each}
          </div>
        </div>

        <div class="options">
          <h3>Output</h3>
          <div class="field">
            <span>Organize files by</span>
            <div class="seg small">
              <button class:on={grouping === "tag"} onclick={() => (grouping = "tag")}>Tag</button>
              <button class:on={grouping === "path"} onclick={() => (grouping = "path")}>Path</button>
              <button class:on={grouping === "single"} onclick={() => (grouping = "single")}>Single file</button>
            </div>
          </div>
          <label class="field">
            <span>Base URL variable</span>
            <div class="var-input">
              <span class="muted mono">{"{{"}</span>
              <input class="input mono" bind:value={baseUrlVariable} placeholder="baseUrl" />
              <span class="muted mono">{"}}"}</span>
            </div>
            <small class="muted">Server URLs are written to <span class="mono">http-client.env.json</span>.</small>
          </label>
          <div class="field">
            <span>Parameter descriptions</span>
            <Toggle checked={paramDescriptions} onchange={(v) => (paramDescriptions = v)} label={paramDescriptions ? "Included" : "Not included"} title="Write each parameter's description, allowed values and default as # @param / # @header comments" />
            <small class="muted">Shown next to params and headers. Request descriptions are always included.</small>
          </div>
          <label class="field">
            <span>Output directory</span>
            <input class="input mono" bind:value={outputDir} placeholder="Choose a folder" title={outputDir} />
            <button class="btn small browse" onclick={browseOutput}>Browse…</button>
          </label>
          <div class="estimate">
            <Icon name="file" size={14} />
            <span><strong>{selected.size}</strong> operation{selected.size === 1 ? "" : "s"} → <strong>{fileCount}</strong> file{fileCount === 1 ? "" : "s"}</span>
          </div>
          <p class="note muted">Required parameters are enabled; optional query parameters and headers are added disabled so you can switch them on when needed. Credentials become variables stored in <span class="mono">http-client.private.env.json</span>.</p>
        </div>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    {#if step === "select"}
      <button class="btn ghost" onclick={() => (step = "source")} disabled={generating}>Back</button>
    {/if}
    <div class="spacer"></div>
    <button class="btn" onclick={close}>Cancel</button>
    {#if step === "source"}
      <button class="btn primary" onclick={load} disabled={loading || !(kind === "file" ? filePath : url).trim()}>
        {#if loading}<span class="spinner"></span>Loading…{:else}Load specification{/if}
      </button>
    {:else}
      <button class="btn primary" onclick={generate} disabled={generating || !selected.size || !outputDir.trim()}>
        {#if generating}<span class="spinner"></span>Generating…{:else}Generate {selected.size} request{selected.size === 1 ? "" : "s"}{/if}
      </button>
    {/if}
  {/snippet}
</Modal>

<style>
  .source {
    padding: 22px 26px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 640px;
  }
  .intro {
    margin: 0;
    line-height: 1.55;
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    padding: 2px;
    border-radius: 6px;
    background: var(--panel-3);
    border: 1px solid var(--border);
  }
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: none;
    color: var(--muted);
    padding: 5px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }
  .seg button.on {
    background: var(--panel);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .seg.small button {
    padding: 4px 10px;
    font-size: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field > span {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .grow {
    flex: 1;
  }
  .load-error {
    border-radius: var(--radius);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    align-items: flex-start;
  }
  .select {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .spec-head {
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  .spec-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .pill {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--panel-3);
    color: var(--text-2);
  }
  .servers {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 6px;
    font-size: 12px;
  }
  .desc {
    font-family: var(--font);
  }
  .warn {
    flex-direction: column;
    align-items: stretch;
  }
  .warn-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: none;
    color: inherit;
    padding: 0;
    cursor: pointer;
    font-size: 12px;
  }
  .warn ul {
    margin: 6px 0 2px;
    padding-left: 22px;
    max-height: 90px;
    overflow: auto;
    color: var(--text-2);
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .ops {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }
  .ops-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .filter .input {
    height: 26px;
    width: 220px;
  }
  .small-text {
    font-size: 12px;
  }
  .op-list {
    flex: 1;
    overflow: auto;
    padding: 4px 0 10px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px 4px 6px;
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 1;
  }
  .group-name {
    font-weight: 600;
    flex: 1;
    cursor: pointer;
  }
  .op-list :global(.op) {
    display: flex;
    width: 100%;
    gap: 10px;
    padding: 4px 12px 4px 38px;
  }
  .op-list :global(.op:hover) {
    background: var(--hover);
  }
  .path {
    flex: none;
    max-width: 50%;
    font-size: 12px;
  }
  .summary {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }
  :global(.op.deprecated) .path,
  :global(.op.deprecated) .summary {
    text-decoration: line-through;
    text-decoration-color: var(--faint);
  }
  .dep {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
    flex: none;
  }
  .options {
    width: 290px;
    flex: none;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: auto;
    background: var(--panel-2);
  }
  h3 {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .var-input {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .var-input .input {
    flex: 1;
  }
  .browse {
    align-self: flex-start;
  }
  small {
    font-size: 11.5px;
    line-height: 1.4;
  }
  .estimate {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--text-2);
  }
  .note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
