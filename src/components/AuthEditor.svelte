<script lang="ts">
  import type { Auth, AuthKind } from "../lib/types";
  import { basicUsernameError, headerNameError } from "../lib/http";
  import SectionBar from "./SectionBar.svelte";
  import Icon from "./Icon.svelte";

  let { auth }: { auth: Auth } = $props();
  let reveal = $state(false);

  // A header key is written as a header line; either way the name goes on the `# @httpdesk-auth` line, which splits at spaces.
  const keyNameError = $derived(
    auth.keyLocation === "header" ? headerNameError(auth.keyName) : /\s/.test(auth.keyName) ? "Key names can't contain spaces" : null,
  );
  const usernameError = $derived(basicUsernameError(auth.username));

  const kinds: { value: AuthKind; label: string }[] = [
    { value: "none", label: "No Auth" },
    { value: "basic", label: "Basic Auth" },
    { value: "bearer", label: "Bearer Token" },
    { value: "apiKey", label: "API Key" },
  ];

  const preview = $derived.by(() => {
    switch (auth.kind) {
      case "basic":
        return `Authorization: Basic ${auth.username || "<user>"} ${auth.password ? "••••" : "<password>"}`;
      case "bearer":
        return `Authorization: Bearer ${auth.token || "<token>"}`;
      case "apiKey":
        return auth.keyLocation === "header" ? `${auth.keyName || "<name>"}: ${auth.keyValue || "<value>"}` : `?${auth.keyName || "<name>"}=${auth.keyValue || "<value>"}`;
      default:
        return "";
    }
  });
</script>

<SectionBar title="Authorization" enabled={auth.enabled} onchange={(v) => (auth.enabled = v)} showToggle={auth.kind !== "none"} />

<div class="auth" class:off={!auth.enabled && auth.kind !== "none"}>
  <div class="left">
    <label class="field">
      <span>Type</span>
      <select class="select" bind:value={auth.kind}>
        {#each kinds as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
      </select>
    </label>
    <p class="muted help">
      {#if auth.kind === "none"}
        This request does not use any authorization.
      {:else if auth.kind === "basic"}
        Username and password are Base64-encoded into the Authorization header when the request is sent.
      {:else if auth.kind === "bearer"}
        The token is sent in the Authorization header. Use <code>{"{{variables}}"}</code> to keep secrets in an environment.
      {:else}
        The key is sent as a header or query parameter.
      {/if}
    </p>
    {#if preview}
      <div class="preview">
        <span class="muted">In the .http file</span>
        <code class="selectable">{auth.enabled ? "" : "#~ "}{preview}</code>
      </div>
    {/if}
  </div>

  <div class="right">
    {#if auth.kind === "basic"}
      <label class="field">
        <span>Username</span>
        <input class="input mono" bind:value={auth.username} placeholder={"{{username}}"} spellcheck="false" aria-invalid={usernameError ? "true" : undefined} />
        {#if usernameError}<span class="field-error" role="alert">{usernameError}</span>{/if}
      </label>
      <label class="field">
        <span>Password</span>
        <div class="with-btn">
          <input class="input mono" type={reveal ? "text" : "password"} bind:value={auth.password} placeholder={"{{password}}"} spellcheck="false" />
          <button class="icon-btn" title={reveal ? "Hide" : "Show"} onclick={() => (reveal = !reveal)}><Icon name={reveal ? "eye-off" : "eye"} /></button>
        </div>
      </label>
    {:else if auth.kind === "bearer"}
      <label class="field">
        <span>Token</span>
        <div class="with-btn">
          <input class="input mono" type={reveal || auth.token.startsWith("{{") ? "text" : "password"} bind:value={auth.token} placeholder={"{{token}}"} spellcheck="false" />
          <button class="icon-btn" title={reveal ? "Hide" : "Show"} onclick={() => (reveal = !reveal)}><Icon name={reveal ? "eye-off" : "eye"} /></button>
        </div>
      </label>
    {:else if auth.kind === "apiKey"}
      <label class="field">
        <span>Key</span>
        <input class="input mono" bind:value={auth.keyName} placeholder="X-API-Key" spellcheck="false" aria-invalid={keyNameError ? "true" : undefined} />
        {#if keyNameError}<span class="field-error" role="alert">{keyNameError}</span>{/if}
      </label>
      <label class="field"><span>Value</span><input class="input mono" bind:value={auth.keyValue} placeholder={"{{apiKey}}"} spellcheck="false" /></label>
      <label class="field">
        <span>Add to</span>
        <select class="select" bind:value={auth.keyLocation}>
          <option value="header">Header</option>
          <option value="query">Query params</option>
        </select>
      </label>
    {/if}
  </div>
</div>

<style>
  .auth {
    display: grid;
    grid-template-columns: minmax(200px, 0.8fr) 1.2fr;
    gap: 24px;
  }
  .auth.off .right,
  .auth.off .preview code {
    opacity: 0.5;
  }
  .left,
  .right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .left {
    border-right: 1px solid var(--border);
    padding-right: 24px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .field .input,
  .field .select {
    width: 100%;
    color: var(--text);
  }
  .field-error {
    color: var(--danger);
    font-size: 11.5px;
  }
  .field .input[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .with-btn {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .help {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
  }
  code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.5px;
  }
  .preview code {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    border: 1px solid var(--border);
    word-break: break-all;
    color: var(--text-2);
  }
</style>
