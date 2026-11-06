<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import type { Request, BodyMode } from "../lib/types";
  import type { VarProvider } from "../lib/codemirror/setup";
  import { bodySyntaxHighlight } from "../lib/codemirror/setup";
  import {
    bodySyntaxWarnings,
    boundaryOf,
    buildForm,
    buildMultipart,
    dirname,
    findHeader,
    parseFileRef,
    parseForm,
    parseMultipart,
    prettyJson,
    prettyXml,
    relativePath,
    setBodyMode,
    setHeader,
    type FormField,
    type MultipartPart,
  } from "../lib/http";
  import Editor from "../lib/codemirror/Editor.svelte";
  import SectionBar from "./SectionBar.svelte";
  import Icon from "./Icon.svelte";

  let { req, filePath, variables }: { req: Request; filePath: string; variables: VarProvider | null } = $props();

  const modes: { value: BodyMode; label: string }[] = [
    { value: "none", label: "none" },
    { value: "json", label: "JSON" },
    { value: "xml", label: "XML" },
    { value: "text", label: "Text" },
    { value: "formUrlEncoded", label: "x-www-form-urlencoded" },
    { value: "multipart", label: "form-data" },
    { value: "file", label: "File" },
    { value: "raw", label: "Raw" },
  ];

  const body = $derived(req.body);
  const contentType = $derived(findHeader(req, "content-type")?.value ?? "");
  const boundary = $derived(boundaryOf(contentType) ?? "HttpDeskBoundary");

  // ---- form-urlencoded: local rows synced with body text
  let formRows = $state<FormField[]>([]);
  $effect(() => {
    if (body.mode === "formUrlEncoded" && buildForm(formRows) !== body.text) formRows = parseForm(body.text);
  });
  function setForm(i: number, field: "name" | "value", v: string) {
    if (i === formRows.length) formRows.push({ name: "", value: "", [field]: v });
    else formRows[i][field] = v;
    body.text = buildForm(formRows);
  }

  // ---- multipart
  let parts = $state<MultipartPart[]>([]);
  $effect(() => {
    if (body.mode === "multipart" && buildMultipart(parts, boundary) !== body.text) parts = parseMultipart(body.text, boundary);
  });
  function setPart(i: number, patch: Partial<MultipartPart>) {
    if (i === parts.length) parts.push({ name: "", kind: "text", value: "", ...patch });
    else Object.assign(parts[i], patch);
    body.text = buildMultipart(parts, boundary);
  }
  function removePart(i: number) {
    parts.splice(i, 1);
    body.text = buildMultipart(parts, boundary);
  }
  async function pickFile(onPicked: (rel: string) => void) {
    const f = await open({ multiple: false, title: "Choose file" });
    if (typeof f === "string") onPicked(relativePath(dirname(filePath), f));
  }

  // ---- file
  const fileRef = $derived(parseFileRef(body.text));
  function setFileRef(path: string, substitute: boolean) {
    body.text = `<${substitute ? "@" : ""} ${path}`;
  }

  function beautify() {
    if (body.mode === "json") {
      const p = prettyJson(body.text);
      if (p !== null) body.text = p;
    } else if (body.mode === "xml") {
      body.text = prettyXml(body.text);
    }
  }

  // A disabled body is written as `#~|` lines, so it can't collide.
  const syntaxWarnings = $derived(body.enabled && body.mode !== "none" && body.mode !== "file" ? bodySyntaxWarnings(body.text) : []);

  const language = $derived(body.mode === "json" ? "json" : body.mode === "xml" ? "xml" : "text");
  const formRowsView = $derived([...formRows, { name: "", value: "" }]);
  const partsView = $derived([...parts, { name: "", kind: "text" as const, value: "" }]);
</script>

<SectionBar title="Body" enabled={body.enabled} onchange={(v) => (body.enabled = v)} showToggle={body.mode !== "none"}>
  {#if body.mode === "json" || body.mode === "xml"}
    <button class="link small-link" onclick={beautify}>Beautify</button>
  {/if}
</SectionBar>

<div class="modes" role="radiogroup">
  {#each modes as m (m.value)}
    <label class="mode" class:active={body.mode === m.value}>
      <input type="radio" name="body-mode" checked={body.mode === m.value} onchange={() => setBodyMode(req, m.value)} />
      {m.label}
    </label>
  {/each}
</div>

<div class="content" class:off={!body.enabled && body.mode !== "none"}>
  {#if body.mode === "none"}
    <div class="none muted">This request does not have a body.</div>
  {:else if body.mode === "formUrlEncoded"}
    <div class="grid">
      <div class="g-head"><span>Key</span><span>Value</span><span></span></div>
      {#each formRowsView as row, i (i)}
        {@const ghost = i === formRows.length}
        <div class="g-row">
          <input class="cell" value={row.name} placeholder={ghost ? "Add key" : "Key"} spellcheck="false" oninput={(e) => setForm(i, "name", e.currentTarget.value)} />
          <input class="cell" value={row.value} placeholder="Value" spellcheck="false" oninput={(e) => setForm(i, "value", e.currentTarget.value)} />
          <span class="del">
            {#if !ghost}<button class="icon-btn" onclick={() => (formRows.splice(i, 1), (body.text = buildForm(formRows)))}><Icon name="trash" size={13} /></button>{/if}
          </span>
        </div>
      {/each}
    </div>
  {:else if body.mode === "multipart"}
    <div class="grid multipart">
      <div class="g-head"><span>Key</span><span>Type</span><span>Value</span><span>Content type</span><span></span></div>
      {#each partsView as p, i (i)}
        {@const ghost = i === parts.length}
        <div class="g-row">
          <input class="cell" value={p.name} placeholder={ghost ? "Add key" : "Key"} spellcheck="false" oninput={(e) => setPart(i, { name: e.currentTarget.value })} />
          <select class="cell kind" value={p.kind} onchange={(e) => setPart(i, { kind: e.currentTarget.value as "text" | "file" })}>
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>
          {#if p.kind === "file"}
            <span class="file-cell">
              <input class="cell" value={p.value} placeholder="./path/to/file" spellcheck="false" oninput={(e) => setPart(i, { value: e.currentTarget.value })} />
              <button class="btn small" onclick={() => pickFile((rel) => setPart(i, { value: rel }))}>Choose…</button>
            </span>
          {:else}
            <input class="cell" value={p.value} placeholder="Value" spellcheck="false" oninput={(e) => setPart(i, { value: e.currentTarget.value })} />
          {/if}
          <input class="cell" value={p.contentType ?? ""} placeholder="auto" spellcheck="false" oninput={(e) => setPart(i, { contentType: e.currentTarget.value || undefined })} />
          <span class="del">{#if !ghost}<button class="icon-btn" onclick={() => removePart(i)}><Icon name="trash" size={13} /></button>{/if}</span>
        </div>
      {/each}
    </div>
    <p class="muted note">Boundary <code>{boundary}</code> (from the Content-Type header). Files are referenced relative to the .http file.</p>
  {:else if body.mode === "file"}
    <div class="file-mode">
      <label class="field">
        <span class="muted">File (relative to the .http file)</span>
        <span class="row">
          <input class="input mono" value={fileRef?.path ?? ""} placeholder="./payload.json" spellcheck="false" oninput={(e) => setFileRef(e.currentTarget.value, !!fileRef?.substitute)} />
          <button class="btn" onclick={() => pickFile((rel) => setFileRef(rel, !!fileRef?.substitute))}>Choose…</button>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={!!fileRef?.substitute} onchange={(e) => setFileRef(fileRef?.path ?? "", e.currentTarget.checked)} />
        Substitute <code>{"{{variables}}"}</code> inside the file
      </label>
      <label class="field">
        <span class="muted">Content-Type</span>
        <input class="input mono" value={contentType} placeholder="application/octet-stream" spellcheck="false" oninput={(e) => setHeader(req, "Content-Type", e.currentTarget.value)} />
      </label>
    </div>
  {:else}
    {#if body.mode === "raw"}
      <label class="ct row">
        <span class="muted">Content-Type</span>
        <input class="input mono" value={contentType} placeholder="application/octet-stream" spellcheck="false" oninput={(e) => setHeader(req, "Content-Type", e.currentTarget.value)} />
      </label>
    {/if}
    <div class="code">
      <Editor value={body.text} onchange={(v) => (body.text = v)} {language} {variables} placeholder="Request body" extensions={bodySyntaxHighlight} />
    </div>
  {/if}
  {#if syntaxWarnings.length}
    <div class="syntax-warnings" role="status">
      <Icon name="alert" size={13} />
      <div>
        {#each syntaxWarnings as w (w.line)}<div>{w.message}</div>{/each}
        <div class="muted">Other .http clients read it the same way, and so does HttpDesk when it reloads the file. Indent the line to keep it in the body.</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-bottom: 10px;
  }
  .mode {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .mode.active {
    color: var(--text);
  }
  .mode input {
    accent-color: var(--accent);
    margin: 0;
  }
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .content.off {
    opacity: 0.55;
  }
  .syntax-warnings {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: 8px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    background: rgba(232, 182, 76, 0.12);
    color: var(--warning);
    font-size: 12px;
    line-height: 1.5;
  }
  .syntax-warnings .muted {
    color: var(--muted);
  }
  .none {
    padding: 30px 0;
    text-align: center;
    font-size: 12.5px;
  }
  .code {
    flex: 1;
    min-height: 160px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
  .ct {
    margin-bottom: 8px;
    font-size: 12px;
  }
  .ct .input {
    flex: 1;
  }
  .grid {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }
  .g-head,
  .g-row {
    display: grid;
    grid-template-columns: 38% 1fr 34px;
    min-height: 31px;
  }
  .multipart .g-head,
  .multipart .g-row {
    grid-template-columns: 26% 80px 1fr 130px 34px;
  }
  .g-head {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .g-head span {
    padding-left: 11px;
  }
  .g-row + .g-row {
    border-top: 1px solid var(--border);
  }
  .cell {
    border: none;
    border-right: 1px solid var(--border);
    background: transparent;
    outline: none;
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 0 10px;
    min-width: 0;
  }
  .cell:focus {
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--focus);
  }
  select.cell {
    font-family: var(--font);
    padding: 0 6px;
  }
  .file-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    border-right: 1px solid var(--border);
    padding-right: 4px;
    min-width: 0;
  }
  .file-cell .cell {
    flex: 1;
    border-right: none;
    align-self: stretch;
  }
  .del {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .del .icon-btn {
    width: 24px;
    height: 24px;
    opacity: 0;
  }
  .g-row:hover .del .icon-btn {
    opacity: 1;
  }
  .note {
    font-size: 11.5px;
    margin: 8px 0 0;
  }
  code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .file-mode {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 620px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
  }
  .field .row .input {
    flex: 1;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--text-2);
  }
  .check input {
    accent-color: var(--accent);
    margin: 0;
  }
  .small-link {
    font-size: 12px;
  }
</style>
