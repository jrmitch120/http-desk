<script lang="ts">
  import { untrack } from "svelte";
  import type { HttpFile, KeyValue, Request } from "../lib/types";
  import { getDirective, setDirective, variableNameError } from "../lib/http";
  import Toggle from "./Toggle.svelte";
  import KeyValueGrid from "./KeyValueGrid.svelte";

  let { req, file }: { req: Request; file: HttpFile } = $props();

  const followRedirects = $derived(getDirective(req, "no-redirect") === undefined);
  // JetBrains semantics: `@timeout` is the idle time between received data, `@connection-timeout` limits only connecting.
  const timeouts = [
    { directive: "timeout", label: "Idle timeout", hint: "Longest wait for the next data from the server." },
    { directive: "connection-timeout", label: "Connection timeout", hint: "Longest wait to connect." },
  ];
  const description = $derived(req.comments.join("\n"));
  const otherDirectives = $derived(req.directives.filter((d) => !["no-redirect", "timeout", "connection-timeout"].includes(d.name.toLowerCase())));

  // File variables are edited as KeyValue rows (always enabled). Rows are re-read
  // when the file object changes (e.g. reloaded from disk) and written back on edit.
  const toRows = (f: HttpFile): KeyValue[] => f.header.variables.map((v) => ({ enabled: true, name: v.name, value: v.value }));
  let fileVars = $state<KeyValue[]>(untrack(() => toRows(file)));
  let boundFile = untrack(() => file);
  $effect.pre(() => {
    if (file !== boundFile) {
      boundFile = file;
      fileVars = toRows(file);
    }
  });
  $effect(() => {
    const vars = fileVars.filter((v) => v.name).map((v) => ({ name: v.name, value: v.value }));
    untrack(() => {
      if (JSON.stringify(vars) !== JSON.stringify(file.header.variables)) file.header.variables = vars;
    });
  });

  const preserved = $derived(
    [
      req.preScript && "a pre-request script",
      req.responseHandler && "a response handler",
      req.extraLines.length && `${req.extraLines.length} other line${req.extraLines.length > 1 ? "s" : ""} in the header area`,
    ].filter(Boolean) as string[],
  );
</script>

<div class="settings">
  <section>
    <h3>Request</h3>
    <label class="field">
      <span>Name</span>
      <input class="input" bind:value={req.name} placeholder="Request name" />
    </label>
    <label class="field">
      <span>Description <em class="muted">(saved as # comments above the request)</em></span>
      <textarea class="input" rows="3" value={description} oninput={(e) => (req.comments = e.currentTarget.value === "" ? [] : e.currentTarget.value.split("\n"))}></textarea>
    </label>
  </section>

  <section>
    <h3>Behavior</h3>
    <div class="line">
      <div>
        <div>Follow redirects</div>
        <div class="muted sub">When off, saved as <code># @no-redirect</code></div>
      </div>
      <Toggle ariaLabel="Follow redirects" checked={followRedirects} onchange={(v) => setDirective(req, "no-redirect", v ? null : "")} />
    </div>
    {#each timeouts as t (t.directive)}
      <div class="line">
        <div>
          <div>{t.label}</div>
          <div class="muted sub">{t.hint} Seconds, or e.g. <code>500 ms</code>, <code>2 m</code>; empty uses the app default. Saved as <code># @{t.directive}</code></div>
        </div>
        <input
          class="input mono num"
          aria-label={t.label}
          value={getDirective(req, t.directive) ?? ""}
          placeholder="default"
          oninput={(e) => setDirective(req, t.directive, e.currentTarget.value.trim() ? e.currentTarget.value.trim() : null)}
        />
      </div>
    {/each}
    <label class="field">
      <span>HTTP version <em class="muted">(optional, e.g. HTTP/1.1)</em></span>
      <input class="input mono narrow" value={req.httpVersion ?? ""} oninput={(e) => (req.httpVersion = e.currentTarget.value.trim() || null)} placeholder="—" />
    </label>
  </section>

  <section>
    <h3>File variables</h3>
    <p class="muted sub">Defined at the top of this file as <code>@name = value</code> and available to every request in it. They override environment values.</p>
    <KeyValueGrid bind:items={fileVars} columns={["name", "value", "delete"]} namePlaceholder="Variable" valuePlaceholder="Value" separator="=" nameError={variableNameError} />
  </section>

  {#if otherDirectives.length || preserved.length}
    <section>
      <h3>Preserved content</h3>
      {#if otherDirectives.length}
        <p class="muted sub">Other directives:</p>
        <ul>
          {#each otherDirectives as d, i (i)}<li><code># @{d.name}{d.value ? ` ${d.value}` : ""}</code></li>{/each}
        </ul>
      {/if}
      {#if preserved.length}
        <p class="muted sub">This request also contains {preserved.join(", ")}. HttpDesk keeps it intact but does not run scripts.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 22px;
    max-width: 720px;
  }
  section {
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .field .input {
    color: var(--text);
  }
  em {
    font-style: normal;
  }
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 0;
  }
  .sub {
    font-size: 11.5px;
    margin: 2px 0 0;
    line-height: 1.5;
  }
  .num {
    width: 110px;
  }
  .narrow {
    width: 160px;
  }
  code {
    font-family: var(--mono);
    font-size: 11px;
  }
  ul {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
  }
</style>
