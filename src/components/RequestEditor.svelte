<script lang="ts">
  import { tick, untrack } from "svelte";
  import { app, type RequestTab } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { GlobalVariable, KeyValue, PortabilityMark } from "../lib/types";
  import { applyUrlText, basename, composeUrl, displayName, fileVariables, headerNameError, HEADER_NAMES, methodClass, customMethod, requestNames, requestPrompts, STANDARD_METHODS } from "../lib/http";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import { promptAnswersOf } from "../lib/promptAnswers.svelte";
  import { sessionView } from "../lib/sessionView.svelte";
  import { bodyFilePaths, portabilityLineMarks, requestChecks, type Check, type QuickFix, type Section } from "../lib/checks";
  import { sourceProblems } from "../lib/problems.svelte";
  import { checkUnderlines } from "../lib/codemirror/underlines";
  import { inDocument } from "../lib/codemirror/lineEndings";
  import { readingCard, workspaceFile } from "../lib/exchanges";
  import { AUTH_FIELDS } from "../lib/usages";
  import type { Definition } from "../lib/codemirror/setup";
  import { setReadOnlyRegion } from "../lib/codemirror/readOnly";
  import ReadOnlyRegion from "../lib/codemirror/ReadOnlyRegion.svelte";
  import { afterPause, sourceView, VIEW_REFRESH_DELAY_MS } from "../lib/textViews.svelte";
  import FileBanners from "./FileBanners.svelte";
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
  import { editorMemoryKey } from "../lib/editorMemory";

  let { tab }: { tab: RequestTab } = $props();

  const doc = $derived(app.docs[tab.path]);
  const req = $derived(app.requestFor(tab));
  const run = $derived(app.runs[tab.id]);
  const dirty = $derived(app.isRequestDirty(tab.path, tab.key));
  const docDirty = $derived(app.isDocDirty(tab.path));
  const orphaned = $derived(app.isOrphaned(tab));
  // Read-only while a view of the file holds text that doesn't parse (#174): its
  // CodeMirror fields and editors through the region, its other controls disabled. While
  // only its own source does (`ownSource`), that source can still be edited.
  const lock = $derived(app.texts.lock(tab));
  const ownSource = $derived(lock?.heldBy.kind === "request" && lock.heldBy.key === tab.key);
  setReadOnlyRegion(() => !!lock);
  /** The request's Source view, among the views of its file holding typed text. */
  const view = $derived(sourceView(tab.key));
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

  /** The request as JSON, made once per change: what its readings are asked with and compared by. */
  const reqJson = $derived(req ? JSON.stringify(req) : null);

  // What the core found reading the request's source: asked when it's opened (at once)
  // and after each edit (debounced like the source), for the strip and the underlines.
  $effect(() => {
    const snap = reqJson;
    if (snap === null) return;
    const key = tab.key;
    const t = setTimeout(() => sourceProblems.refresh(key, JSON.parse(snap)), untrack(() => sourceProblems.read(key)) ? VIEW_REFRESH_DELAY_MS : 0);
    return () => clearTimeout(t);
  });
  // While the source holds typed text that doesn't parse, the request stays at its last
  // valid state, so the core's reading of it doesn't place anything in the text shown:
  // the problems and body files found reading the typed text do (#163, #165).
  const typedSource = $derived(app.texts.typed(tab.path, view));
  const reading = $derived(
    typedSource && !typedSource.parses ? { snap: reqJson ?? "", read: { problems: typedSource.problems, files: typedSource.files } } : sourceProblems.read(tab.key),
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
    const snap = reqJson;
    if (snap === null) return;
    const typed = typedSource?.text ?? null;
    return afterPause(
      () => (typed !== null ? api.portabilityText(typed) : api.requestPortability(JSON.parse(snap))).catch((): PortabilityMark[] => []),
      (marks) => (portability = marks),
    );
  });
  const sourceMarks = $derived(portabilityLineMarks(portability, app.portability));

  // Pre-send checks: the strip, and each section tab's count of Undefined variables.
  const checks = $derived(
    req && variables
      ? requestChecks(req, variables, {
          set: envSet,
          envName: app.envName,
          dir: app.folderOf(tab.path),
          file: doc.file.requests,
          found: { read: reading?.read, exists: (path) => sourceProblems.exists(tab.path, path) },
          portability: { marks: portability, settings: app.portability },
        })
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
  const sourceInvalid = $derived(app.texts.isInvalid(tab.path, view));
  /** Where the source stops parsing: what its note says. */
  const sourceError = $derived(app.texts.firstError(tab.path, view));
  const lineBreak = $derived(app.texts.lineBreak(tab.path));

  let sourceEditor = $state<Editor>();
  let sourceBox = $state<HTMLElement>();
  /** One of the request's own `@name` lines (index into `variables`) to select once the source shows it. */
  let declaration = $state<number | null>(null);

  // A Find usages result or a hover card's Edit: show the field holding the reference. A
  // request's own `@name` lines have no field of their own, so its .http source shows them,
  // with the line selected.
  let urlInput = $state<UrlInput>();
  let nameInput = $state<HTMLInputElement>();
  // The full name, as a tooltip, only while the breadcrumb cuts it short.
  const clippedName = () => (nameInput && nameInput.scrollWidth > nameInput.clientWidth ? nameInput.value || nameInput.placeholder : "");
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
  // The source follows the request (`follow`): its own typed text as it is, any other
  // change (an edit in the sections or the URL bar) rendered again, shortly after, or at
  // once when the source has just been shown.
  $effect(() => {
    if (!showSource) return;
    return app.texts.follow(
      tab.path,
      view,
      (text, how) => {
        // Text the user reverted to goes in as a change Undo takes back.
        if (how.undoable && source !== text) sourceEditor?.replace(text);
        source = text;
        sourceOf = untrack(() => reqJson);
      },
      untrack(() => sourceOf) !== null,
    );
  });
  // The strip's checks in the source: the core's problems only when it read the version of the request shown.
  const underlines = $derived.by(() => {
    const found = checkUnderlines(source, reading?.snap === sourceOf ? checks : checks.filter((c) => c.kind !== "problem"));
    // In a file with mixed endings the text keeps each `\r\n`; the editor's document has one character per break.
    return lineBreak ? inDocument(source, found) : found;
  });
  // Shown again (the .http button, its shortcut): the cursor is where it was left.
  let sourceWasShown = untrack(() => showSource);
  $effect(() => {
    if (showSource && !sourceWasShown) {
      sourceMounted = true;
      tick().then(() => sourceEditor?.focus());
    }
    if (!showSource) sourceOf = null;
    // Hidden with the focus in it (its shortcut): the focus goes on to the URL, not nowhere.
    if (!showSource && sourceWasShown && sourceBox?.contains(document.activeElement)) tick().then(() => urlInput?.focus());
    sourceWasShown = showSource;
  });
  $effect(() => {
    if (declaration === null || !showSource || !req || !sourceEditor || sourceOf !== reqJson) return;
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
</script>

{#if !doc || !req}
  <div class="empty-state">This request is no longer available.</div>
{:else}
  <div class="editor">
    <FileBanners {doc} {orphaned} />
    <!-- While only its own source doesn't parse, the source says so itself. -->
    {#if lock && !(ownSource && showSource)}
      <Banner severity="info">
        {lock.reason}
        {#snippet actions()}
          {#if lock.heldBy.kind === "file"}
            {@const error = app.texts.firstError(tab.path, lock.heldBy)}
            <button class="btn small" onclick={() => app.openFileView(tab.path, error ? { line: error.line, column: error.column } : { key: tab.key })}>
              {error ? `Show line ${error.line} in the file view` : "Show file view"}
            </button>
          {:else if ownSource}
            <button class="btn small" onclick={() => app.toggleSource()}>Show source</button>
          {/if}
        {/snippet}
      </Banner>
    {/if}

    <div class="crumbs">
      <span class="file" use:tooltip={tab.path}>{basename(tab.path)}</span>
      <Icon name="chevron-right" size={12} />
      <input class="name-input" readonly={!!lock} value={req.name} placeholder={displayName(req)} oninput={(e) => (req.name = e.currentTarget.value)} spellcheck="false" bind:this={nameInput} use:tooltip={clippedName} />
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
      <button class="btn small ghost" aria-label="View file as text" onclick={() => app.openFileView(tab.path, { key: tab.key })} use:tooltip={`View all of ${basename(tab.path)} as text, at this request`}>
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
    <!-- Its quick fixes edit the request or the file. Above the sections; under the source
         (below), where an entry that comes and goes with the typing doesn't move the text. -->
    {#snippet strip()}
      <fieldset class="lockable" disabled={!!lock}>
        <CheckStrip {checks} onfix={fix} />
      </fieldset>
    {/snippet}
    {#if !showSource}{@render strip()}{/if}

    {#if sourceMounted}
      <div class="source" hidden={!showSource} bind:this={sourceBox}>
        <!-- One line either way, so the text below doesn't move as typing passes through text that doesn't parse. -->
        <div class="source-note" class:muted={!sourceInvalid} class:invalid={sourceInvalid} role="status">
          {#if sourceInvalid}
            <Icon name="alert" size={12} />
            <span class="ellipsis">
              {#if sourceError}<span class="line">Line {sourceError.line}</span> {sourceError.message}{:else}This text doesn't parse.{/if}
              Until it does, the request stays as it last read, and can be edited only here.
            </span>
            {#if sourceError}
              <button class="link" onclick={() => sourceEditor?.revealLine(sourceError.line, { caret: sourceError.column })}>Go to line {sourceError.line}</button>
            {/if}
          {:else}
            <span class="ellipsis">This request as it's written to <code>{basename(tab.path)}</code>. Edit it here or in the sections.</span>
          {/if}
        </div>
        <div class="source-code">
          <ReadOnlyRegion when={() => !!lock && !ownSource}>
            <Editor bind:this={sourceEditor} value={source} onchange={(text) => app.texts.edit(tab.path, view, text)} onsend={() => app.send(tab.id)} freshHistory language="http" {variables} {underlines} lineMarks={sourceMarks} {lineBreak} memory={editorMemoryKey(tab.id, "source")} label={`${displayName(req)} as .http source`} />
          </ReadOnlyRegion>
        </div>
      </div>
    {/if}
    {#if showSource}<div class="under-source">{@render strip()}</div>{/if}
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
  /* The name takes all the room the buttons leave (no spacer sharing it) and
     ends in "…" when it still doesn't fit. */
  .name-input {
    flex: 1;
    min-width: 60px;
    text-overflow: ellipsis;
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
  /* The strip keeps its own bottom margin; this is the gap above it. */
  .under-source {
    flex: none;
    margin-top: var(--space-2);
  }
  .under-source:not(:has(.checks)) {
    display: none;
  }
  .source-note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 11.5px;
    line-height: 16px;
    padding: var(--space-2) var(--space-4);
  }
  .source-note.invalid {
    color: var(--text-2);
  }
  .source-note.invalid :global(svg) {
    flex: none;
    color: var(--danger);
  }
  .source-note .line {
    font-family: var(--mono);
    color: var(--muted);
  }
  .source-note .link {
    flex: none;
    font-size: inherit;
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
