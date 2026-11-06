<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { api } from "../lib/api";
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
    prettyXml,
    relativePath,
    setBodyMode,
    setHeader,
    type FormField,
    type MultipartPart,
  } from "../lib/http";
  import Editor from "../lib/codemirror/Editor.svelte";
  import Checkbox from "./Checkbox.svelte";
  import KeyValueGrid, { type Column, type GridCell } from "./KeyValueGrid.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import SectionBar from "./SectionBar.svelte";
  import Banner from "./Banner.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";

  let { req, filePath, variables, onsend }: { req: Request; filePath: string; variables: VarProvider | null; onsend?: () => void } = $props();

  const modes: SegmentedOption<BodyMode>[] = [
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

  // ---- form-urlencoded and multipart: local rows, parsed from the body text and
  // written back on every edit in the grid. A disabled row is a `#~` line in the
  // text (ARCHITECTURE §5, ADR-0003).
  let formRows = $state<FormField[]>([]);
  $effect(() => {
    if (body.mode === "formUrlEncoded" && buildForm(formRows) !== body.text) formRows = parseForm(body.text);
  });
  const blankField = (): FormField => ({ name: "", value: "", enabled: true });

  let parts = $state<MultipartPart[]>([]);
  $effect(() => {
    if (body.mode === "multipart" && buildMultipart(parts, boundary) !== body.text) parts = parseMultipart(body.text, boundary);
  });
  const blankPart = (): MultipartPart => ({ name: "", kind: "text", value: "", enabled: true });
  const kinds: SelectOption<MultipartPart["kind"]>[] = [
    { value: "text", label: "Text" },
    { value: "file", label: "File" },
  ];
  const partColumns: Column<MultipartPart>[] = [
    "enable",
    { id: "name", width: "26%" },
    { id: "kind", header: "Type", width: "84px", cell: kindCell },
    { id: "value", header: "Value", width: "1fr", cell: partValueCell },
    { id: "content-type", header: "Content type", width: "130px", cell: contentTypeCell },
    "delete",
  ];

  async function pickFile(onPicked: (rel: string) => void) {
    const f = await open({ multiple: false, title: "Choose file" });
    if (typeof f === "string") onPicked(relativePath(dirname(filePath), f));
  }

  // ---- file
  const fileRef = $derived(parseFileRef(body.text));
  function setFileRef(path: string, substitute: boolean) {
    body.text = `<${substitute ? "@" : ""} ${path}`;
  }

  async function beautify() {
    if (body.mode === "json") {
      // Formatted in the core so numbers stay as written. Invalid JSON (or a
      // `{{var}}` in a value position) leaves the body as it is.
      const target = body;
      const text = target.text;
      try {
        const pretty = await api.formatBody(text, "json", "pretty");
        if (target.text === text) target.text = pretty; // unless edited meanwhile
      } catch {
        // not valid JSON: nothing to do
      }
    } else if (body.mode === "xml") {
      body.text = prettyXml(body.text);
    }
  }

  // A disabled body is written as `#~|` lines, so it can't collide.
  const syntaxWarnings = $derived(body.enabled && body.mode !== "none" && body.mode !== "file" ? bodySyntaxWarnings(body.text) : []);

  const language = $derived(body.mode === "json" ? "json" : body.mode === "xml" ? "xml" : "text");
</script>

{#snippet kindCell({ row, set }: GridCell<MultipartPart>)}
  <Select size="sm" class="kind" label="Type of {row.name || 'new part'}" options={kinds} value={row.kind} onchange={(kind) => set({ kind })} />
{/snippet}

{#snippet partValueCell({ row, set }: GridCell<MultipartPart>)}
  {#if row.kind === "file"}
    <span class="file-cell">
      <input class="cell c-value" value={row.value} placeholder="./path/to/file" spellcheck="false" oninput={(e) => set({ value: e.currentTarget.value })} />
      <button class="btn small" onclick={() => pickFile((rel) => set({ value: rel }))}>Choose…</button>
    </span>
  {:else}
    <input class="cell c-value" value={row.value} placeholder="Value" spellcheck="false" oninput={(e) => set({ value: e.currentTarget.value })} />
  {/if}
{/snippet}

{#snippet contentTypeCell({ row, set }: GridCell<MultipartPart>)}
  <input class="cell" value={row.contentType ?? ""} placeholder="auto" spellcheck="false" oninput={(e) => set({ contentType: e.currentTarget.value || undefined })} />
{/snippet}

<SectionBar title="Body" enabled={body.enabled} onchange={(v) => (body.enabled = v)} showToggle={body.mode !== "none"}>
  {#if body.mode === "json" || body.mode === "xml"}
    <button class="link small-link" onclick={beautify}>Beautify</button>
  {/if}
</SectionBar>

<div class="modes">
  <SegmentedControl label="Body type" options={modes} value={body.mode} onchange={(m) => setBodyMode(req, m)} />
</div>

<div class="content" class:off={!body.enabled && body.mode !== "none"}>
  {#if body.mode === "none"}
    <div class="none muted">This request does not have a body.</div>
  {:else if body.mode === "formUrlEncoded"}
    <KeyValueGrid bind:items={formRows} label="Form fields" columns={["enable", "name", "value", "delete"]} blank={blankField} carry={["comments", "after"]} separator="=" onchange={(rows) => (body.text = buildForm(rows))} />
  {:else if body.mode === "multipart"}
    <KeyValueGrid bind:items={parts} label="Form-data parts" columns={partColumns} blank={blankPart} carry={["kind", "contentType"]} onchange={(rows) => (body.text = buildMultipart(rows, boundary))} />
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
      <Checkbox class="check" checked={!!fileRef?.substitute} onchange={(on) => setFileRef(fileRef?.path ?? "", on)}>
        Substitute <code>{"{{variables}}"}</code> inside the file
      </Checkbox>
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
      <Editor value={body.text} onchange={(v) => (body.text = v)} {language} {variables} {onsend} placeholder="Request body" extensions={bodySyntaxHighlight} />
    </div>
  {/if}
  {#if syntaxWarnings.length}
    <Banner severity="warning" inline class="syntax-warnings">
      {#each syntaxWarnings as w (w.line)}<div>{w.message}</div>{/each}
      <div class="muted">Other .http clients read it the same way, and so does HttpDesk when it reloads the file. Indent the line to keep it in the body.</div>
    </Banner>
  {/if}
</div>

<style>
  .modes {
    display: flex;
    margin-bottom: 10px;
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
  .content :global(.syntax-warnings) {
    margin-top: 8px;
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
  /* Multipart cells: the part type Select fills its cell without a box of its own. */
  .content :global(.kind) {
    flex: 1;
    align-self: center;
    margin: 0 4px;
    border-color: transparent;
    background: transparent;
  }
  .file-cell {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 4px;
    min-width: 0;
  }
  .file-cell .cell {
    flex: 1;
    align-self: stretch;
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
  .file-mode :global(.check) {
    align-self: flex-start;
    font-size: 12px;
    color: var(--text-2);
  }
  .small-link {
    font-size: 12px;
  }
</style>
