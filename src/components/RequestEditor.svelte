<script module lang="ts">
  // Remember the selected section per tab across tab switches.
  const sectionByTab = new Map<string, string>();
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { applyUrlText, basename, composeUrl, displayName, fileVariables, methodClass, STANDARD_METHODS } from "../lib/http";
  import { makeVarProvider } from "../lib/vars";
  import UrlInput from "../lib/codemirror/UrlInput.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import KeyValueTable from "./KeyValueTable.svelte";
  import SectionBar from "./SectionBar.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import BodyEditor from "./BodyEditor.svelte";
  import RequestSettings from "./RequestSettings.svelte";
  import Icon from "./Icon.svelte";

  let { tab }: { tab: Tab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const req = $derived(app.requestFor(tab));
  const run = $derived(app.runs[tab.id]);
  const dirty = $derived(app.isRequestDirty(tab.path, tab.key));
  const docDirty = $derived(app.isDocDirty(tab.path));
  const variables = $derived(doc ? makeVarProvider(app.envVariables, fileVariables(doc.file), app.envName) : null);

  let section = $state(untrack(() => sectionByTab.get(tab.id)) ?? "params");
  $effect(() => {
    sectionByTab.set(tab.id, section);
  });

  let showSource = $state(false);
  let source = $state("");
  $effect(() => {
    if (!showSource || !req) return;
    const snap = JSON.stringify(req);
    const t = setTimeout(async () => {
      source = await api.renderRequest(JSON.parse(snap)).catch((e) => `# ${e}`);
    }, 120);
    return () => clearTimeout(t);
  });

  const HEADER_NAMES = [
    "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Connection", "Content-Type",
    "Content-Length", "Cookie", "Host", "If-Match", "If-None-Match", "If-Modified-Since", "Origin", "Referer",
    "User-Agent", "X-Api-Key", "X-Request-Id", "X-Correlation-Id", "X-Forwarded-For",
  ];

  const qCount = $derived(req ? req.query.items.filter((i) => i.enabled && i.name).length : 0);
  const hCount = $derived(req ? req.headers.items.filter((i) => i.enabled && i.name).length : 0);
  const authLabel = $derived(req ? { none: "", basic: "Basic", bearer: "Bearer", apiKey: "API key" }[req.auth.kind] : "");
  const bodyLabel = $derived(
    req && req.body.mode !== "none"
      ? { json: "JSON", xml: "XML", text: "Text", formUrlEncoded: "Form", multipart: "Multipart", file: "File", raw: "Raw", none: "" }[req.body.mode]
      : "",
  );

  async function chooseMethod(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    if (!req) return;
    if (sel.value === "__custom") {
      sel.value = req.method;
      const m = await app.prompt("Custom HTTP method", STANDARD_METHODS.includes(req.method) ? "" : req.method, "PURGE");
      if (m && /^[A-Za-z][A-Za-z0-9_-]*$/.test(m.trim())) req.method = m.trim().toUpperCase();
      else if (m) app.toast("error", "A method must be a single token of letters, digits, '-' or '_'.");
    } else {
      req.method = sel.value;
    }
  }

  async function reloadFromDisk() {
    await app.reload(tab.path);
  }
</script>

{#if !doc || !req}
  <div class="empty-state">This request is no longer available.</div>
{:else}
  <div class="editor">
    {#if doc.missing}
      <div class="banner error"><Icon name="alert" />{basename(tab.path)} was deleted or moved on disk. Saving will recreate it.</div>
    {:else if doc.externalChange}
      <div class="banner warning">
        <Icon name="alert" />
        <span>{basename(tab.path)} changed on disk while you have unsaved edits.</span>
        <span class="spacer"></span>
        <button class="btn small" onclick={reloadFromDisk}>Reload from disk</button>
        <button class="btn small" onclick={() => (doc.externalChange = false)}>Keep my version</button>
      </div>
    {/if}

    <div class="crumbs">
      <span class="file" title={tab.path}>{basename(tab.path)}</span>
      <Icon name="chevron-right" size={12} />
      <input class="name-input" value={req.name} placeholder={displayName(req)} oninput={(e) => (req.name = e.currentTarget.value)} spellcheck="false" />
      <span class="spacer"></span>
      <button class="btn small ghost" class:on={showSource} onclick={() => (showSource = !showSource)} title="Show the .http source for this request">
        <Icon name="code" size={14} />.http
      </button>
      <button class="btn small" disabled={!docDirty} onclick={() => app.save(tab.path)} title="Save (⌘/Ctrl S)">
        <Icon name="save" size={14} />Save{#if dirty}<span class="dot"></span>{/if}
      </button>
    </div>

    <div class="urlbar">
      <select class="method {methodClass(req.method)}" value={STANDARD_METHODS.includes(req.method) ? req.method : req.method} onchange={chooseMethod} title="HTTP method">
        {#each STANDARD_METHODS as m (m)}<option value={m} class={methodClass(m)}>{m}</option>{/each}
        {#if !STANDARD_METHODS.includes(req.method)}<option value={req.method}>{req.method}</option>{/if}
        <option value="__custom">Custom…</option>
      </select>
      <UrlInput
        value={composeUrl(req)}
        onchange={(v) => applyUrlText(req, v)}
        onenter={() => app.send(tab.id)}
        placeholder={"Enter URL, e.g. {{baseUrl}}/users"}
        {variables}
      />
      {#if run?.loading}
        <button class="btn send cancel" onclick={() => app.cancel(tab.id)}><Icon name="stop" size={13} />Cancel</button>
      {:else}
        <button class="btn primary send" onclick={() => app.send(tab.id)} title="Send (⌘/Ctrl Enter)"><Icon name="send" size={13} />Send</button>
      {/if}
    </div>

    {#if showSource}
      <div class="source">
        <div class="source-note muted">Read-only preview of how this request is written to <code>{basename(tab.path)}</code>.</div>
        <div class="source-code"><Editor value={source} readonly language="text" /></div>
      </div>
    {:else}
      <nav class="subtabs">
        <button class="subtab" class:active={section === "params"} class:off={!req.query.enabled} onclick={() => (section = "params")}>
          <span class="label">Params</span>
          {#if !req.query.enabled}<span class="off-pill">OFF</span>{:else if qCount}<span class="count">{qCount}</span>{/if}
        </button>
        <button class="subtab" class:active={section === "headers"} class:off={!req.headers.enabled} onclick={() => (section = "headers")}>
          <span class="label">Headers</span>
          {#if !req.headers.enabled}<span class="off-pill">OFF</span>{:else if hCount}<span class="count">{hCount}</span>{/if}
        </button>
        <button class="subtab" class:active={section === "auth"} class:off={!req.auth.enabled && req.auth.kind !== "none"} onclick={() => (section = "auth")}>
          <span class="label">Authorization</span>
          {#if authLabel}{#if req.auth.enabled}<span class="count">{authLabel}</span>{:else}<span class="off-pill">OFF</span>{/if}{/if}
        </button>
        <button class="subtab" class:active={section === "body"} class:off={!req.body.enabled && req.body.mode !== "none"} onclick={() => (section = "body")}>
          <span class="label">Body</span>
          {#if bodyLabel}{#if req.body.enabled}<span class="count">{bodyLabel}</span>{:else}<span class="off-pill">OFF</span>{/if}{/if}
        </button>
        <button class="subtab" class:active={section === "settings"} onclick={() => (section = "settings")}>
          <span class="label">Settings</span>
        </button>
      </nav>

      <div class="panel" class:fill={section === "body"}>
        {#if section === "params"}
          <SectionBar title="Query parameters" enabled={req.query.enabled} onchange={(v) => (req.query.enabled = v)} />
          <KeyValueTable bind:items={req.query.items} sectionEnabled={req.query.enabled} namePlaceholder="Key" valuePlaceholder="Value" separator="=" />
          <p class="hint muted">Use <code>{"{{variable}}"}</code> anywhere. Path parameters are written as <code>{"{{name}}"}</code> in the URL.</p>
        {:else if section === "headers"}
          <SectionBar title="Headers" enabled={req.headers.enabled} onchange={(v) => (req.headers.enabled = v)} />
          <KeyValueTable bind:items={req.headers.items} sectionEnabled={req.headers.enabled} namePlaceholder="Header" valuePlaceholder="Value" suggestions={HEADER_NAMES} />
          {#if req.auth.kind !== "none" && req.auth.enabled}
            <p class="hint muted">An authorization {req.auth.kind === "apiKey" && req.auth.keyLocation === "query" ? "query parameter" : "header"} is added from the Authorization tab.</p>
          {/if}
        {:else if section === "auth"}
          <AuthEditor auth={req.auth} />
        {:else if section === "body"}
          <BodyEditor {req} filePath={tab.path} {variables} />
        {:else}
          <RequestSettings {req} file={doc.file} />
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .editor {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px 4px 16px;
    color: var(--muted);
    flex: none;
  }
  .file {
    font-size: 12.5px;
    white-space: nowrap;
  }
  .name-input {
    flex: 1;
    min-width: 60px;
    max-width: 520px;
    border: 1px solid transparent;
    background: none;
    border-radius: var(--radius-sm);
    padding: 3px 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    outline: none;
  }
  .name-input:hover {
    border-color: var(--border);
  }
  .name-input:focus {
    border-color: var(--focus);
    background: var(--panel-2);
  }
  .btn.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .urlbar {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 6px 14px 12px 16px;
    flex: none;
  }
  .method {
    height: 32px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    background: var(--panel-2);
    font-family: var(--mono);
    font-weight: 700;
    font-size: 12.5px;
    padding: 0 10px;
    min-width: 104px;
    outline: none;
    cursor: pointer;
  }
  .method:focus {
    border-color: var(--focus);
  }
  .method option {
    background: var(--panel-2);
  }
  .send {
    height: 32px;
    margin-left: 8px;
    min-width: 92px;
    font-weight: 600;
  }
  .send.cancel {
    color: var(--text);
  }
  .panel {
    flex: 1;
    overflow: auto;
    padding: 12px 16px 20px;
    min-height: 0;
  }
  .panel.fill {
    display: flex;
    flex-direction: column;
  }
  .hint {
    font-size: 11.5px;
    margin: 10px 2px 0;
  }
  code {
    font-family: var(--mono);
    font-size: 11px;
  }
  .source {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--border);
  }
  .source-note {
    font-size: 11.5px;
    padding: 8px 16px;
  }
  .source-code {
    flex: 1;
    min-height: 0;
    margin: 0 16px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
</style>
