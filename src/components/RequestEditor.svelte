<script lang="ts">
  import { tick, untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { GlobalVariable, KeyValue, PortabilityMark } from "../lib/types";
  import { applyUrlText, basename, composeUrl, displayName, fileVariables, headerNameError, HEADER_NAMES, methodClass, customMethod, requestNames, requestPrompts, STANDARD_METHODS } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { promptAnswersOf } from "../lib/promptAnswers.svelte";
  import { sessionView } from "../lib/sessionView.svelte";
  import { bodyFilePaths, portabilityLineMarks, requestChecks, type Check, type QuickFix, type Section } from "../lib/checks";
  import { sourceProblems } from "../lib/problems.svelte";
  import { checkUnderlines } from "../lib/codemirror/underlines";
  import { readingCard, workspaceFile } from "../lib/exchanges";
  import { AUTH_FIELDS } from "../lib/usages";
  import type { Definition } from "../lib/codemirror/setup";
  import { setReadOnlyRegion } from "../lib/codemirror/readOnly";
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
  // Read-only while another view of the file holds text that doesn't parse (#174): its
  // CodeMirror fields and editors through the region, its other controls disabled.
  const lock = $derived(app.viewLock(tab));
  setReadOnlyRegion(() => !!lock);
  // The request's own environments: its folder's (ADR-0004). An environment the folder
  // doesn't define gives none, like the send.
  const envSet = $derived(app.envSetFor(tab.path));
  const answers = promptAnswersOf(() => tab);
  // The Session's Global variables, which every request can use: read again whenever the Session changes.
  const globals = sessionView<GlobalVariable[]>(() => api.sessionGlobals(), []);
  const variables = $derived.by(() => {
    if (!doc) return null;
    const scope = {
      env: envVariables(envSet, app.envName),
      fileVars: fileVariables(doc.file),
      headerVars: doc.file.header.variables,
      requestVars: req?.variables ?? [],
      globals: Object.fromEntries((globals.current ?? []).map((g) => [g.name, g.value])),
      envName: app.envName,
      prompts: req ? requestPrompts(req) : [],
      answers: answers.current,
      requestNames: requestNames(doc.file),
      exchange: (name: string) => app.exchangeShape(tab.path, name),
    };
    return {
      ...makeVarProvider(scope),
      edit: (d: Definition) => app.editDefinition(tab.id, d),
      findUsages: (name: string) => app.findUsages(name),
      // Extract puts `{{name}}` in the text, so a read-only tab doesn't offer it.
      extract: lock ? undefined : (value: string) => app.extractVariable(tab.id, value),
      readRequestVariable: async (reference: string) => {
        const reading = await api.requestVariable(tab.path, reference).catch(() => null);
        return reading && readingCard(reading, workspaceFile(app.root, tab.path));
      },
    };
  });

  // What the core found reading the request's source: asked when it's opened (at once)
  // and after each edit (debounced like the source), for the strip and the underlines.
  $effect(() => {
    if (!req) return;
    const key = tab.key;
    const snap = JSON.stringify(req);
    const t = setTimeout(() => sourceProblems.refresh(key, JSON.parse(snap)), untrack(() => sourceProblems.read(key)) ? 120 : 0);
    return () => clearTimeout(t);
  });
  // While the source holds typed text that doesn't parse, the request stays at its last
  // valid state, so the core's reading of it doesn't place anything in the text shown:
  // the problems found reading the typed text do (#163).
  const typedSource = $derived(app.sourceText(tab.path, tab.key));
  const reading = $derived(
    typedSource && !typedSource.parses ? { snap: JSON.stringify(req), read: { problems: typedSource.problems, files: [] } } : sourceProblems.read(tab.key),
  );
  // Whether each file the body reads exists: asked when the request is opened and when a path changes.
  const bodyFiles = $derived(variables ? bodyFilePaths(reading?.read, variables).map((f) => f.path).join("\n") : "");
  $effect(() => {
    const [file, paths] = [tab.path, bodyFiles];
    for (const path of paths ? paths.split("\n") : []) void sourceProblems.check(file, path);
  });

  /**
   * The constructs in the request's source and how VS Code and Rider treat each
   * (`request_portability`), for the strip's portability notes and the source's gutter.
   * Like the problems, they're placed in the text the Source view shows: the text
   * typed there, while it holds any (it may not read as a request), else the request's.
   */
  let portability = $state<PortabilityMark[]>([]);
  $effect(() => {
    if (!req) return;
    const typed = typedSource?.text ?? null;
    const snap = JSON.stringify(req);
    let stale = false;
    const t = setTimeout(async () => {
      const marks = await (typed !== null ? api.portabilityText(typed) : api.requestPortability(JSON.parse(snap))).catch(() => []);
      if (!stale) portability = marks;
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  });
  const sourceMarks = $derived(portabilityLineMarks(portability, app.portabilityLevel));

  // Pre-send checks: the strip, and each section tab's count of Undefined variables.
  const checks = $derived(
    req && variables
      ? requestChecks(
          req,
          variables,
          envSet,
          app.envName,
          app.folderOf(tab.path),
          doc.file.requests,
          { read: reading?.read, exists: (path) => sourceProblems.exists(tab.path, path) },
          { marks: portability, level: app.portabilityLevel },
        )
      : [],
  );
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

  // The selected section lives with the tab, so it outlasts a tab switch and the Layout can save it.
  const section = $derived(tab.section);
  // "Open request Settings" on a timeout error.
  $effect(() => {
    if (app.requestSettingsFor === tab.id) {
      app.showSection(tab.id, "settings");
      app.requestSettingsFor = null;
    }
  });

  /** The `.http` source shows in place of the sections; an app setting, so it lasts like Resolved. */
  const showSource = $derived(app.settings?.showSource === true);
  /** The resolved preview (ResolvedPreview) is shown under the URL bar; an app setting, so it lasts. */
  const resolved = $derived(app.settings?.showResolved === true);
  /**
   * The source editor, once first shown, stays (hidden behind the sections), so
   * its cursor and undo history outlast a switch to the sections and back.
   */
  let sourceMounted = $state(untrack(() => showSource));
  /** The source text: what the user typed, or the request rendered by the core. */
  let source = $state("");
  /** The request (as JSON) `source` is up to date with. */
  let sourceOf = $state<string | null>(null);
  const sourceInvalid = $derived(app.isSourceInvalid(tab.path, tab.key));
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
    // A request's own `@name` line shows only in its source; every other field only in the sections.
    const wantSource = field.kind === "variable";
    if (showSource !== wantSource) void app.updateSettings({ showSource: wantSource });
    if (field.kind === "url") {
      tick().then(() => urlInput?.focus());
      return;
    }
    if (field.kind === "variable") {
      declaration = field.index;
      return;
    }
    app.showSection(tab.id, field.kind === "param" ? "params" : field.kind === "header" ? "headers" : field.kind);
    tick().then(() => {
      if (field.kind === "param") paramsGrid?.focusValue(req.query.items[field.index]);
      else if (field.kind === "header") headersGrid?.focusValue(req.headers.items[field.index]);
      else if (field.kind === "auth") panel?.querySelector<HTMLElement>(`[role="textbox"][aria-label="${AUTH_FIELDS[field.part].label}"]`)?.focus();
    });
  });
  // The source follows the request. A change that came from the source itself (the
  // text the user typed, read into the request) shows that text as it is, so the
  // editor isn't touched and its cursor never jumps. Any other change (an edit in
  // the sections or the URL bar) renders the request again, shortly after, or at
  // once when the source has just been shown.
  $effect(() => {
    if (!showSource || !req) return;
    const snap = JSON.stringify(req);
    const typed = app.sourceText(tab.path, tab.key);
    if (typed) {
      source = typed.text;
      sourceOf = snap;
      return;
    }
    const t = setTimeout(
      async () => {
        const text = await app.sourceFor(tab.path, tab.key).catch((e) => `# ${e}`);
        if (text === null || JSON.stringify(app.requestFor(tab)) !== snap) return;
        source = text;
        sourceOf = snap;
      },
      untrack(() => sourceOf) === null ? 0 : 120,
    );
    return () => clearTimeout(t);
  });
  // The strip's checks in the source: the core's problems only when it read the version of the request shown.
  const underlines = $derived(checkUnderlines(source, reading?.snap === sourceOf ? checks : checks.filter((c) => c.kind !== "problem")));
  // Shown again (the .http button, its shortcut): the cursor is where it was left.
  let sourceWasShown = untrack(() => showSource);
  $effect(() => {
    if (showSource && !sourceWasShown) {
      sourceMounted = true;
      tick().then(() => sourceEditor?.focus());
    }
    if (!showSource) sourceOf = null;
    sourceWasShown = showSource;
  });
  $effect(() => {
    if (declaration === null || !showSource || !req || !sourceEditor || sourceOf !== JSON.stringify(req)) return;
    // The request's named `@name` lines are in order in its block, before anything else
    // starting with `@`; the text before the block (`leading`) comes first.
    const nth = req.variables.slice(0, declaration + 1).filter((v) => v.name).length;
    const skip = req.leading.split("\n").length - 1;
    let seen = 0;
    const line = source.split("\n").findIndex((l, i) => i >= skip && l.startsWith("@") && ++seen === nth) + 1;
    declaration = null;
    tick().then(() => sourceEditor?.revealLine(line));
  });

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
    {#if lock}
      <Banner severity="info">
        {lock.reason}
        {#snippet actions()}
          {#if lock.heldBy.kind === "file"}
            <button class="btn small" onclick={() => app.openFileView(tab.path)}>Show file view</button>
          {/if}
        {/snippet}
      </Banner>
    {/if}

    <div class="crumbs">
      <span class="file" use:tooltip={tab.path}>{basename(tab.path)}</span>
      <Icon name="chevron-right" size={12} />
      <input class="name-input" readonly={!!lock} value={req.name} placeholder={displayName(req)} oninput={(e) => (req.name = e.currentTarget.value)} spellcheck="false" />
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
      <button class="btn small ghost" class:on={showSource} aria-pressed={showSource} onclick={() => app.toggleSource()} use:tooltip={`${showSource ? "Show the sections" : "Edit each request's .http source in place of its sections"} (${shortcutHint("show-source")})`}>
        <Icon name="code" size={14} />.http
      </button>
      <button class="btn small ghost" aria-label="View file as text" onclick={() => app.openFileView(tab.path)} use:tooltip={`View all of ${basename(tab.path)} as text`}>
        <Icon name="file" size={14} />File
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
        disabled={!!lock}
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
    <!-- Its quick fixes edit the request or the file. -->
    <fieldset class="lockable" disabled={!!lock}>
      <CheckStrip {checks} onfix={fix} />
    </fieldset>

    {#if sourceMounted}
      <div class="source" hidden={!showSource}>
        <div class="source-note muted">
          {#if sourceInvalid}
            This text doesn't read as a request yet. Until it does, the request stays as it last read.
          {:else}
            This request as it's written to <code>{basename(tab.path)}</code>. Edit it here or in the sections.
          {/if}
        </div>
        <div class="source-code">
          <Editor bind:this={sourceEditor} value={source} onchange={(text) => app.editSource(tab.path, tab.key, text)} onsend={() => app.send(tab.id)} freshHistory language="http" {variables} {underlines} lineMarks={sourceMarks} />
        </div>
      </div>
    {/if}
    {#if !showSource}
      {#snippet undefinedCount(s: Section)}
        {@const n = undefinedIn(s)}
        {#if n}
          <span class="undefined-count" use:tooltip={`${n} Undefined variable${n > 1 ? "s" : ""}`}><Badge tone="danger">{n}</Badge></span>
        {/if}
      {/snippet}
      <nav class="subtabs">
        <button class="subtab" class:active={section === "params"} class:off={!req.query.enabled} onclick={() => app.showSection(tab.id, "params")}>
          <span class="label">Params</span>
          {#if !req.query.enabled}<Badge>OFF</Badge>{:else if qCount}<span class="count">{qCount}</span>{/if}
          {@render undefinedCount("params")}
        </button>
        <button class="subtab" class:active={section === "headers"} class:off={!req.headers.enabled} onclick={() => app.showSection(tab.id, "headers")}>
          <span class="label">Headers</span>
          {#if !req.headers.enabled}<Badge>OFF</Badge>{:else if hCount}<span class="count">{hCount}</span>{/if}
          {@render undefinedCount("headers")}
        </button>
        <button class="subtab" class:active={section === "auth"} class:off={!req.auth.enabled && req.auth.kind !== "none"} onclick={() => app.showSection(tab.id, "auth")}>
          <span class="label">Authorization</span>
          {#if authLabel}{#if req.auth.enabled}<span class="count">{authLabel}</span>{:else}<Badge>OFF</Badge>{/if}{/if}
          {@render undefinedCount("auth")}
        </button>
        <button class="subtab" class:active={section === "body"} class:off={!req.body.enabled && req.body.mode !== "none"} onclick={() => app.showSection(tab.id, "body")}>
          <span class="label">Body</span>
          {#if bodyLabel}{#if req.body.enabled}<span class="count">{bodyLabel}</span>{:else}<Badge>OFF</Badge>{/if}{/if}
          {@render undefinedCount("body")}
        </button>
        <button class="subtab" class:active={section === "settings"} onclick={() => app.showSection(tab.id, "settings")}>
          <span class="label">Settings</span>
        </button>
      </nav>

      <div class="panel" class:fill={section === "body"} bind:this={panel}>
        <fieldset class="lockable" disabled={!!lock}>
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
            <RequestSettings {req} bind:file={doc.file} filePath={tab.path} {variables} />
          {/if}
        </fieldset>
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
  .panel.fill,
  .panel.fill > .lockable {
    display: flex;
    flex-direction: column;
  }
  .panel.fill > .lockable {
    flex: 1;
    min-height: 0;
  }
  /* Only there to disable what's in it while the tab is read-only (#174). */
  .lockable {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
    min-inline-size: 0;
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
  .source[hidden] {
    display: none;
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
