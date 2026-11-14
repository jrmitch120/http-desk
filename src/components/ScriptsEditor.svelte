<script lang="ts">
  // Settings → Scripts: the request's JetBrains pre-request scripts and response
  // handlers. Inline ones are edited here; an edit changes only the script's body
  // (lib/scripts.ts). File references show their path, read-only. HttpDesk never
  // adds a script itself: only these Add buttons do. Each script says which
  // editor it breaks in (ADR-0007), always, not once.
  import { tick } from "svelte";
  import { autocompletion } from "@codemirror/autocomplete";
  import type { Request } from "../lib/types";
  import { addScript, removeScript, requestScripts, scriptBodyProblem, setScriptBody, type Script, type ScriptKind } from "../lib/scripts";
  import { scriptCompletion } from "../lib/scriptApi";
  import Editor from "../lib/codemirror/Editor.svelte";
  import Banner from "./Banner.svelte";

  let { req }: { req: Request } = $props();

  const scripts = $derived(requestScripts(req));
  const LABEL: Record<ScriptKind, string> = { "pre-request": "Pre-request script", handler: "Response handler" };
  // ADR-0007: REST Client sends a `> {% %}` block as body text, and a `< {% %}` above the method line breaks the request.
  const NOTE: Record<ScriptKind, string> = {
    "pre-request": "Runs in Rider; breaks the request in VS Code",
    handler: "Runs in Rider; VS Code sends this as body text",
  };
  const EXTENSIONS: Record<ScriptKind, ReturnType<typeof autocompletion>> = {
    "pre-request": autocompletion({ override: [scriptCompletion("pre-request")], icons: false }),
    handler: autocompletion({ override: [scriptCompletion("handler")], icons: false }),
  };

  const key = (s: Script) => `${s.kind}-${s.index}`;
  const label = (s: Script) => LABEL[s.kind] + (scripts.filter((o) => o.kind === s.kind).length > 1 ? ` ${s.index + 1}` : "");

  let editors = $state<Record<string, Editor | undefined>>({});

  async function add(kind: ScriptKind) {
    addScript(req, kind);
    await tick();
    const added = requestScripts(req).filter((s) => s.kind === kind && s.form === "inline").at(-1);
    if (added) editors[key(added)]?.focus();
  }
</script>

<section class="scripts" role="group" aria-label="Scripts">
  <h3>Scripts</h3>
  <p class="muted sub">
    JetBrains HTTP Client scripts. A pre-request script runs before the request is built, and a response handler after the response arrives. HttpDesk runs both in a Trusted workspace.
  </p>
  {#each scripts as s (key(s))}
    <div class="script" role="group" aria-label={label(s)}>
      <div class="head">
        <span class="name">{label(s)}</span>
        {#if s.form === "inline"}
          <button class="btn small ghost" aria-label="Remove {LABEL[s.kind].toLowerCase()}" onclick={() => removeScript(req, s)}>Remove</button>
        {/if}
      </div>
      {#if s.form === "inline"}
        <div class="code">
          <Editor bind:this={editors[key(s)]} value={s.body} onchange={(v) => setScriptBody(req, s, v)} language="javascript" placeholder="JavaScript" extensions={EXTENSIONS[s.kind]} />
        </div>
        {#if scriptBodyProblem(s.body)}
          <Banner severity="warning" inline>{scriptBodyProblem(s.body)}</Banner>
        {/if}
      {:else}
        <div class="file"><span class="muted">Script file</span> <code>{s.path}</code></div>
      {/if}
      <p class="note muted">{NOTE[s.kind]}</p>
    </div>
  {/each}
  <div class="actions">
    <button class="btn small" onclick={() => add("pre-request")}>Add pre-request script</button>
    <button class="btn small" onclick={() => add("handler")}>Add response handler</button>
  </div>
</section>

<style>
  .scripts {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .sub {
    font-size: 11.5px;
    margin: 2px 0 0;
    line-height: 1.5;
  }
  .script {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }
  .code {
    height: 160px;
    min-height: 60px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
  .file {
    font-size: 12px;
  }
  code {
    font-family: var(--mono);
    font-size: 11px;
  }
  .note {
    margin: 0;
    font-size: 11px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
