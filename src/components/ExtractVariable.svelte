<script module lang="ts">
  type Where = "file" | "env" | "all";
  /** The destination picked last time, offered first next time (this session). */
  let lastWhere: Where = "file";
</script>

<script lang="ts">
  // The Extract to variable form (app.extraction): a name for the selected text
  // and where it is defined. The field that asked replaces its selection with
  // `{{name}}` once the store has written the definition.
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import { extractConflict, extractNameError, type ExtractTarget } from "../lib/extract";
  import { basename } from "../lib/http";
  import Modal from "./Modal.svelte";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import Banner from "./Banner.svelte";

  const x = app.extraction!;
  const tab = app.tabs.find((t) => t.id === x.tabId);
  const doc = tab && app.docs[tab.path];
  const request = app.requestFor(tab ?? null);
  const envName = app.envName;
  const envCount = app.envSet?.environments.length ?? 0;

  const options: SegmentedOption<Where>[] = [
    { value: "file", label: "File variable" },
    ...(envName ? [{ value: "env" as const, label: `Environment "${envName}"` }] : []),
    ...(envCount ? [{ value: "all" as const, label: "All environments" }] : []),
  ];
  let where = $state<Where>(options.some((o) => o.value === lastWhere) ? lastWhere : "file");
  let name = $state("");
  let input: HTMLInputElement | undefined = $state();

  const target = $derived<ExtractTarget>(where === "env" && envName ? { kind: "env", env: envName } : where === "all" ? { kind: "all" } : { kind: "file" });
  const error = $derived(extractNameError(name.trim()));
  const warning = $derived(doc && !error ? extractConflict(target, name.trim(), { file: doc.file, request, envSet: app.envSet }) : null);
  const ready = $derived(!!name.trim() && !error);
  const help = $derived(
    where === "file"
      ? `Adds @${name.trim() || "name"} = … at the top of ${tab ? basename(tab.path) : "the file"}.`
      : where === "env"
        ? `Adds it to ${envName} in http-client.env.json.`
        : `Adds it to every environment with this value; change the others afterwards.`,
  );

  onMount(() => input?.focus());

  function submit() {
    if (!ready) return;
    lastWhere = where;
    app.closeExtraction({ name: name.trim(), target });
  }
</script>

<Modal title="Extract to variable" width="460px" onclose={() => app.closeExtraction(null)}>
  <div class="body">
    <div class="field">
      <span class="label">Value</span>
      <code class="value">{x.value}</code>
    </div>
    <div class="field">
      <label class="label" for="extract-name">Name</label>
      <input
        id="extract-name"
        class="input mono"
        bind:this={input}
        bind:value={name}
        placeholder="baseUrl"
        spellcheck="false"
        autocomplete="off"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "extract-name-error" : undefined}
        onkeydown={(e) => {
          if (e.key !== "Enter") return;
          // Consumed: focus goes back to the field at once, and the key must not reach it.
          e.preventDefault();
          submit();
        }}
      />
      {#if error}<span class="field-error" id="extract-name-error" role="alert">{error}</span>{/if}
    </div>
    <div class="field">
      <span class="label">Add to</span>
      <SegmentedControl label="Add to" {options} value={where} onchange={(v) => (where = v)} />
      <span class="help">{help}</span>
    </div>
    {#if warning}<Banner severity="warning" inline>{warning}</Banner>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => app.closeExtraction(null)}>Cancel</button>
    <button class="btn primary" disabled={!ready} onclick={submit}>Extract</button>
  {/snippet}
</Modal>

<style>
  .body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .label {
    font-size: 12px;
    color: var(--muted);
  }
  .input {
    width: 100%;
  }
  .value {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    color: var(--text);
  }
  .help {
    font-size: 12px;
    color: var(--muted);
  }
  .field-error {
    font-size: 12px;
    color: var(--danger);
  }
</style>
