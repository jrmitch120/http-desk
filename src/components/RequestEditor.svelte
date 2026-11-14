<script module lang="ts">
  // Remember the selected section per tab across tab switches.
  const sectionByTab = new Map<string, string>();
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { KeyValue } from "../lib/types";
  import { applyUrlText, basename, composeUrl, displayName, fileVariables, headerNameError, methodClass, customMethod, requestPrompts, STANDARD_METHODS } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { promptAnswersOf } from "../lib/promptAnswers.svelte";
  import { requestChecks, type Check, type QuickFix, type Section } from "../lib/checks";
  import { AUTH_FIELDS } from "../lib/usages";
  import type { Definition } from "../lib/codemirror/setup";
  import UrlInput from "../lib/codemirror/UrlInput.svelte";
  import Editor from "../lib/codemirror/Editor.svelte";
  import KeyValueGrid, { type Column } from "./KeyValueGrid.svelte";
  import SectionBar from "./SectionBar.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import BodyEditor from "./BodyEditor.svelte";
  import RequestSettings from "./RequestSettings.svelte";
  import ResolvedPreview from "./ResolvedPreview.svelte";
  import CheckStrip from "./CheckStrip.svelte";
  import Badge from "./Badge.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import Banner from "./Banner.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { shortcutHint } from "../lib/commands";

  let { tab }: { tab: Tab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const req = $derived(app.requestFor(tab));
  const run = $derived(app.runs[tab.id]);
  const dirty = $derived(app.isRequestDirty(tab.path, tab.key));
  const docDirty = $derived(app.isDocDirty(tab.path));
  const orphaned = $derived(app.isOrphaned(tab));
  // The request's own environments: its folder's (ADR-0004). An environment the folder
  // doesn't define gives none, like the send.
  const envSet = $derived(app.envSetFor(tab.path));
  const answers = promptAnswersOf(() => tab);
  const variables = $derived.by(() => {
    if (!doc) return null;
    const scope = {
      env: envVariables(envSet, app.envName),
      fileVars: fileVariables(doc.file),
      headerVars: doc.file.header.variables,
      requestVars: req?.variables ?? [],
      envName: app.envName,
      prompts: req ? requestPrompts(req) : [],
      answers: answers.current,
    };
    return {
      ...makeVarProvider(scope),
      edit: (d: Definition) => app.editDefinition(tab.id, d),
      findUsages: (name: string) => app.findUsages(name),
      extract: (value: string) => app.extractVariable(tab.id, value),
    };
  });

  // Pre-send checks: the strip, and each section tab's count of Undefined variables.
  const checks = $derived(req && variables ? requestChecks(req, variables, envSet, app.envName, app.folderOf(tab.path)) : []);
  function undefinedIn(s: Section): number {
    return checks.filter((c) => c.kind === "undefined" && c.sections.includes(s)).length;
  }
  function fix(check: Check, fix: QuickFix) {
    if (fix.kind === "selectEnvironment") app.selectEnvironment(fix.env);
    else if (fix.kind === "chooseEnvironment") app.chooseEnvironment();
    else if (check.kind !== "undefined") return;
    else if (fix.kind === "addToEnvironment") app.editDefinition(tab.id, { kind: "env", env: fix.env, name: check.name, dir: fix.dir, add: true });
    else app.editDefinition(tab.id, { kind: "file", name: check.name, add: true });
  }

  let section = $state(untrack(() => sectionByTab.get(tab.id)) ?? "params");
  $effect(() => {
    sectionByTab.set(tab.id, section);
  });
  // "Open request Settings" on a timeout error.
  $effect(() => {
    if (app.requestSettingsFor === tab.id) {
      section = "settings";
      app.requestSettingsFor = null;
    }
  });

  // Shown for one tab at a time (the store keeps it, so Request → Show .http Source can
  // toggle it); hidden again when the tab is switched away from, as before.
  const showSource = $derived(app.sourceShownFor === tab.id);
  onDestroy(() => {
    if (app.sourceShownFor === tab.id) app.sourceShownFor = null;
  });
  /** The resolved preview (ResolvedPreview) is shown under the URL bar; an app setting, so it lasts. */
  const resolved = $derived(app.settings?.showResolved === true);
  let source = $state("");
  /** The request (as JSON) `source` was rendered from. */
  let rendered = $state<string | null>(null);
  let sourceEditor = $state<Editor>();
  /** One of the request's own `@name` lines (index into `variables`) to select once the source shows it. */
  let declaration = $state<number | null>(null);

  // A Find usages result or a hover card's Edit: show the field holding the reference. A
  // request's own `@name` lines have no field of their own, so its .http source shows them,
  // with the line selected.
  let urlInput = $state<UrlInput>();
  let paramsGrid = $state<KeyValueGrid<KeyValue>>();
  let headersGrid = $state<KeyValueGrid<KeyValue>>();
  let panel = $state<HTMLElement>();

  $effect(() => {
    const want = app.fieldWanted;
    if (want?.tabId !== tab.id || !req) return;
    app.fieldWanted = null;
    const field = want.field;
    app.sourceShownFor = field.kind === "variable" ? tab.id : null;
    if (field.kind === "url") {
      tick().then(() => urlInput?.focus());
      return;
    }
    if (field.kind === "variable") {
      declaration = field.index;
      return;
    }
    section = field.kind === "param" ? "params" : field.kind === "header" ? "headers" : field.kind;
    tick().then(() => {
      if (field.kind === "param") paramsGrid?.focusValue(req.query.items[field.index]);
      else if (field.kind === "header") headersGrid?.focusValue(req.headers.items[field.index]);
      else if (field.kind === "auth") panel?.querySelector<HTMLElement>(`[role="textbox"][aria-label="${AUTH_FIELDS[field.part].label}"]`)?.focus();
    });
  });
  $effect(() => {
    if (!showSource || !req) return;
    const snap = JSON.stringify(req);
    const t = setTimeout(async () => {
      source = await api.renderRequest(JSON.parse(snap)).catch((e) => `# ${e}`);
      rendered = snap;
    }, 120);
    return () => clearTimeout(t);
  });
  $effect(() => {
    if (declaration === null || !showSource || !req || !sourceEditor || rendered !== JSON.stringify(req)) return;
    // The source lists the request's named `@name` lines in order, before anything else starting with `@`.
    const nth = req.variables.slice(0, declaration + 1).filter((v) => v.name).length;
    let seen = 0;
    const line = source.split("\n").findIndex((l) => l.startsWith("@") && ++seen === nth) + 1;
    declaration = null;
    tick().then(() => sourceEditor?.revealLine(line));
  });

  const HEADER_NAMES = [
    "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Connection", "Content-Type",
    "Content-Length", "Cookie", "Host", "If-Match", "If-None-Match", "If-Modified-Since", "Origin", "Referer",
    "User-Agent", "X-Api-Key", "X-Request-Id", "X-Correlation-Id", "X-Forwarded-For",
  ];
  /** Params and headers: every column, with descriptions (`# @param` / `# @header`). */
  const documented: Column<KeyValue>[] = ["enable", "name", "value", "description", "delete"];
  const showDescriptions = $derived(app.settings?.showDescriptions !== false);

  const qCount = $derived(req ? req.query.items.filter((i) => i.enabled && i.name).length : 0);
  const hCount = $derived(req ? req.headers.items.filter((i) => i.enabled && i.name).length : 0);
  const authLabel = $derived(req ? { none: "", basic: "Basic", bearer: "Bearer", apiKey: "API key" }[req.auth.kind] : "");
  const bodyLabel = $derived(
    req && req.body.mode !== "none"
      ? { json: "JSON", xml: "XML", text: "Text", formUrlEncoded: "Form", multipart: "Multipart", file: "File", raw: "Raw", none: "" }[req.body.mode]
      : "",
  );

  // Every method in its colour; a non-standard one already in use is listed too.
  const methods: SelectOption[] = $derived(
    (req && !STANDARD_METHODS.includes(req.method) ? [...STANDARD_METHODS, req.method] : STANDARD_METHODS).map((m) => ({
      value: m,
      label: m,
      color: `var(--${methodClass(m)})`,
    })),
  );

  async function reloadFromDisk() {
    await app.reload(tab.path);
  }
</script>

{#if !doc || !req}
  <div class="empty-state">This request is no longer available.</div>
{:else}
  <div class="editor">
    {#if doc.missing}
      <Banner severity="error">{basename(tab.path)} was deleted or moved on disk. Saving will recreate it.</Banner>
    {:else if orphaned}
      <Banner severity="error">
        This request no longer exists in {basename(tab.path)}; it was changed or removed on disk. Saving will add it back to the end of the file.
      </Banner>
    {:else if doc.externalChange}
      <Banner severity="warning">
        {basename(tab.path)} changed on disk while you have unsaved edits.
        {#snippet actions()}
          <button class="btn small" onclick={reloadFromDisk}>Reload from disk</button>
          <button class="btn small" onclick={() => (doc.externalChange = false)}>Keep my version</button>
        {/snippet}
      </Banner>
    {/if}

    <div class="crumbs">
      <span class="file" use:tooltip={tab.path}>{basename(tab.path)}</span>
      <Icon name="chevron-right" size={12} />
      <input class="name-input" value={req.name} placeholder={displayName(req)} oninput={(e) => (req.name = e.currentTarget.value)} spellcheck="false" />
      <span class="spacer"></span>
      <button
        class="btn small ghost"
        class:on={resolved}
        aria-pressed={resolved}
        onclick={() => app.updateSettings({ showResolved: !resolved })}
        use:tooltip={resolved ? "Hide the resolved request" : "Show the request as it will be sent, with variables applied"}
      >
        <Icon name="eye" size={14} />Resolved
      </button>
      <button class="btn small ghost" class:on={showSource} aria-pressed={showSource} onclick={() => app.toggleSource(tab.id)} use:tooltip={"Show the .http source for this request"}>
        <Icon name="code" size={14} />.http
      </button>
      <button class="btn small" disabled={!docDirty && !orphaned} onclick={() => app.saveTab(tab)} use:tooltip={`Save (${shortcutHint("save")})`}>
        <Icon name="save" size={14} />Save{#if dirty}<span class="dot"></span>{/if}
      </button>
    </div>

    <div class="urlbar">
      <Select
        class="method"
        options={methods}
        value={req.method}
        onchange={(m) => (req.method = m)}
        create={customMethod}
        label="HTTP method"
        tooltip="HTTP method"
        mono
      />
      <UrlInput
        bind:this={urlInput}
        value={composeUrl(req)}
        onchange={(v) => applyUrlText(req, v)}
        onenter={() => app.send(tab.id)}
        placeholder={"Enter URL, e.g. {{baseUrl}}/users"}
        {variables}
      />
      {#if run?.loading}
        <button class="btn send cancel" onclick={() => app.cancel(tab.id)}><Icon name="stop" size={13} />Cancel</button>
      {:else}
        <button class="btn primary send" onclick={() => app.send(tab.id)} use:tooltip={`Send (${shortcutHint("send")})`}><Icon name="send" size={13} />Send</button>
      {/if}
    </div>

    <ResolvedPreview {tab} />
    <CheckStrip {checks} onfix={fix} />

    {#if showSource}
      <div class="source">
        <div class="source-note muted">Read-only preview of how this request is written to <code>{basename(tab.path)}</code>.</div>
        <div class="source-code"><Editor bind:this={sourceEditor} value={source} readonly language="text" /></div>
      </div>
    {:else}
      {#snippet undefinedCount(s: Section)}
        {@const n = undefinedIn(s)}
        {#if n}
          <span class="undefined-count" use:tooltip={`${n} Undefined variable${n > 1 ? "s" : ""}`}><Badge tone="danger">{n}</Badge></span>
        {/if}
      {/snippet}
      <nav class="subtabs">
        <button class="subtab" class:active={section === "params"} class:off={!req.query.enabled} onclick={() => (section = "params")}>
          <span class="label">Params</span>
          {#if !req.query.enabled}<Badge>OFF</Badge>{:else if qCount}<span class="count">{qCount}</span>{/if}
          {@render undefinedCount("params")}
        </button>
        <button class="subtab" class:active={section === "headers"} class:off={!req.headers.enabled} onclick={() => (section = "headers")}>
          <span class="label">Headers</span>
          {#if !req.headers.enabled}<Badge>OFF</Badge>{:else if hCount}<span class="count">{hCount}</span>{/if}
          {@render undefinedCount("headers")}
        </button>
        <button class="subtab" class:active={section === "auth"} class:off={!req.auth.enabled && req.auth.kind !== "none"} onclick={() => (section = "auth")}>
          <span class="label">Authorization</span>
          {#if authLabel}{#if req.auth.enabled}<span class="count">{authLabel}</span>{:else}<Badge>OFF</Badge>{/if}{/if}
          {@render undefinedCount("auth")}
        </button>
        <button class="subtab" class:active={section === "body"} class:off={!req.body.enabled && req.body.mode !== "none"} onclick={() => (section = "body")}>
          <span class="label">Body</span>
          {#if bodyLabel}{#if req.body.enabled}<span class="count">{bodyLabel}</span>{:else}<Badge>OFF</Badge>{/if}{/if}
          {@render undefinedCount("body")}
        </button>
        <button class="subtab" class:active={section === "settings"} onclick={() => (section = "settings")}>
          <span class="label">Settings</span>
        </button>
      </nav>

      <div class="panel" class:fill={section === "body"} bind:this={panel}>
        {#if section === "params"}
          <SectionBar title="Query parameters" enabled={req.query.enabled} onchange={(v) => (req.query.enabled = v)} />
          <KeyValueGrid bind:this={paramsGrid} bind:items={req.query.items} columns={documented} {showDescriptions} sectionEnabled={req.query.enabled} namePlaceholder="Key" valuePlaceholder="Value" separator="=" {variables} />
          <p class="hint muted">Use <code>{"{{variable}}"}</code> anywhere. Path parameters are written as <code>{"{{name}}"}</code> in the URL.</p>
        {:else if section === "headers"}
          <SectionBar title="Headers" enabled={req.headers.enabled} onchange={(v) => (req.headers.enabled = v)} />
          <KeyValueGrid bind:this={headersGrid} bind:items={req.headers.items} columns={documented} {showDescriptions} sectionEnabled={req.headers.enabled} namePlaceholder="Header" valuePlaceholder="Value" suggestions={HEADER_NAMES} nameError={headerNameError} {variables} />
          {#if req.auth.kind !== "none" && req.auth.enabled}
            <p class="hint muted">An authorization {req.auth.kind === "apiKey" && req.auth.keyLocation === "query" ? "query parameter" : "header"} is added from the Authorization tab.</p>
          {/if}
        {:else if section === "auth"}
          <AuthEditor bind:auth={req.auth} {variables} />
        {:else if section === "body"}
          <BodyEditor {req} filePath={tab.path} {variables} onsend={() => app.send(tab.id)} />
        {:else}
          <RequestSettings {req} bind:file={doc.file} {variables} />
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
  .urlbar :global(.method) {
    flex: none;
    height: 32px;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    font-weight: 700;
    padding: 0 8px 0 10px;
    min-width: 104px;
    max-width: 180px;
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
