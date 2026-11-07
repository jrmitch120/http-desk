<script lang="ts">
  // The Resolved toggle under the URL bar and the preview it shows: the request
  // as it will be sent (active environment and File variables applied), asked of
  // the shell's `preview_request`, which runs the same preparation as a send.
  // Dynamic variables that generate a new value on every send stay as written.
  import { app, type Tab } from "../lib/store.svelte";
  import { errorMessage } from "../lib/api";
  import { fileVariables, methodClass } from "../lib/http";
  import type { RequestPreview } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Toggle from "./Toggle.svelte";

  let { tab }: { tab: Tab } = $props();

  /** Wait after the last edit before asking again, so typing doesn't flood the shell. */
  const DEBOUNCE_MS = 150;

  const show = $derived(app.settings?.showResolved === true);
  let preview = $state<RequestPreview | null>(null);
  let failure = $state<string | null>(null);

  // Everything the preview depends on; a change asks again.
  const inputs = $derived.by(() => {
    const req = app.requestFor(tab);
    const doc = app.docs[tab.path];
    if (!show || !req || !doc) return null;
    return JSON.stringify([req, fileVariables(doc.file), app.envName, app.envSet]);
  });
  let asked = 0;
  $effect(() => {
    if (inputs === null) return;
    const ask = ++asked;
    const t = setTimeout(async () => {
      try {
        const answer = await app.preview(tab);
        if (ask === asked) [preview, failure] = [answer, null];
      } catch (e) {
        if (ask === asked) [preview, failure] = [null, errorMessage(e)];
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  });

  type Kind = "dynamic" | "undefined" | "circular";
  type Part = { text: string; kind?: Kind };
  /** Names a circular reference stops at (left as written), from the preview's warnings. */
  const circular = $derived(
    new Set((preview?.warnings ?? []).flatMap((w) => (w.startsWith("Circular variable reference: ") ? [w.split(" → ").at(-1)!] : []))),
  );
  /** Splits shown text so `{{$uuid}}` placeholders and `{{name}}`s left unresolved can be marked. */
  function parts(text: string): Part[] {
    return text.split(/(\{\{.*?\}\})/).flatMap((text, i): Part[] => {
      if (!text) return [];
      if (i % 2 === 0) return [{ text }];
      const name = text.slice(2, -2).trim();
      return [{ text, kind: name.startsWith("$") ? "dynamic" : circular.has(name) ? "circular" : "undefined" }];
    });
  }
  const NOTES: Record<Kind, string> = {
    dynamic: "Dynamic variable: a new value is generated on every send",
    undefined: "Undefined variable: sent as written",
    circular: "Circular reference: sent as written",
  };

  /** Where a header the request doesn't list itself comes from. */
  function origin(name: string): string | null {
    const req = app.requestFor(tab);
    if (!req) return null;
    const lower = name.toLowerCase();
    const auth = req.auth;
    if (auth.enabled && (auth.kind === "basic" || auth.kind === "bearer") && lower === "authorization") return "from Authorization";
    if (auth.enabled && auth.kind === "apiKey" && auth.keyLocation === "header" && lower === auth.keyName.toLowerCase()) return "from Authorization";
    const own = req.headers.enabled && req.headers.items.some((h) => h.enabled && h.name.toLowerCase() === lower);
    if (own) return null;
    return lower === "content-type" ? "from Body" : "default";
  }
</script>

{#snippet value(text: string)}
  {#each parts(text) as part}
    {#if part.kind}
      <span class="var {part.kind}" use:tooltip={NOTES[part.kind]}>{part.text}</span>
    {:else}{part.text}{/if}
  {/each}
{/snippet}

<div class="resolved-toggle">
  <Toggle
    checked={show}
    label="Resolved"
    title={show ? "Hide the resolved request" : "Show the request as it will be sent, with variables applied"}
    onchange={(v) => app.updateSettings({ showResolved: v })}
  />
</div>

{#if show}
  <section class="resolved" aria-label="Resolved request">
    {#if failure}
      <div class="problem error">{failure}</div>
    {:else if preview}
      <div class="target mono"><span class="method {methodClass(preview.method)}">{preview.method}</span> {@render value(preview.url)}</div>
      {#if preview.error}
        <div class="problem error">Can't be sent: {preview.error.message}</div>
      {/if}
      {#each preview.warnings as warning}
        <div class="problem warning">{warning}</div>
      {/each}
      <div class="section" role="group" aria-label="Headers">
        <div class="heading">Headers</div>
        {#each preview.headers as [name, text]}
          {@const note = origin(name)}
          <div class="row mono">
            <span class="line"><span class="name">{name}</span>: {@render value(text)}</span>
            {#if note}<span class="note">{note}</span>{/if}
          </div>
        {/each}
      </div>
      {#if preview.auth.length}
        <div class="section" role="group" aria-label="Authorization">
          <div class="heading">Authorization</div>
          {#each preview.auth as [label, text]}
            <div class="row mono"><span class="line"><span class="name">{label}</span>: {@render value(text)}</span></div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="muted">Resolving…</div>
    {/if}
  </section>
{/if}

<style>
  .resolved-toggle {
    display: flex;
    align-items: center;
    padding: 0 14px 8px 16px;
    margin-top: -6px;
    flex: none;
    font-size: 12px;
  }
  .resolved {
    flex: none;
    max-height: 40%;
    overflow: auto;
    margin: 0 14px 10px 16px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel-2);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mono {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .target {
    word-break: break-all;
    color: var(--text);
  }
  .method {
    font-weight: 700;
  }
  .heading {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .line {
    word-break: break-all;
    color: var(--text-2);
  }
  .name {
    color: var(--text);
  }
  .note {
    flex: none;
    margin-left: auto;
    color: var(--faint);
    font-family: var(--font);
    font-size: 11px;
  }
  .var.dynamic {
    color: var(--var-dyn);
  }
  .var.undefined,
  .var.circular {
    color: var(--var-bad);
    text-decoration: underline wavy;
    text-underline-offset: 2px;
  }
  .problem {
    font-size: 11.5px;
  }
  .problem.error {
    color: var(--danger);
  }
  .problem.warning {
    color: var(--warning);
  }
</style>
