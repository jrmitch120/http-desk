<script lang="ts">
  import type { ApiKeyLocation, Auth, AuthKind } from "../lib/types";
  import { basicUsernameError, headerNameError } from "../lib/http";
  import SectionBar from "./SectionBar.svelte";
  import Icon from "./Icon.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import VarField from "../lib/codemirror/VarField.svelte";
  import type { VarProvider } from "../lib/codemirror/setup";

  let { auth, variables = null }: { auth: Auth; variables?: VarProvider | null } = $props();
  let reveal = $state(false);

  // A header key is written as a header line; either way the name goes on the `# @httpdesk-auth` line, which splits at spaces.
  const keyNameError = $derived(
    auth.keyLocation === "header" ? headerNameError(auth.keyName) : /\s/.test(auth.keyName) ? "Key names can't contain spaces" : null,
  );
  const usernameError = $derived(basicUsernameError(auth.username));

  const kinds: SelectOption<AuthKind>[] = [
    { value: "none", label: "No Auth" },
    { value: "basic", label: "Basic Auth" },
    { value: "bearer", label: "Bearer Token" },
    { value: "apiKey", label: "API Key" },
  ];
  const locations: SelectOption<ApiKeyLocation>[] = [
    { value: "header", label: "Header" },
    { value: "query", label: "Query params" },
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
    <div class="field">
      <span>Type</span>
      <Select class="auth-select" options={kinds} value={auth.kind} onchange={(v) => (auth.kind = v)} label="Authorization type" />
    </div>
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
      <div class="field">
        <span>Username</span>
        <VarField class="input mono" value={auth.username} onchange={(v) => (auth.username = v)} placeholder={"{{username}}"} label="Username" invalid={!!usernameError} {variables} />
        {#if usernameError}<span class="field-error" role="alert">{usernameError}</span>{/if}
      </div>
      <div class="field">
        <span>Password</span>
        <div class="with-btn">
          <VarField class="input mono" value={auth.password} onchange={(v) => (auth.password = v)} placeholder={"{{password}}"} label="Password" masked={!reveal} {variables} />
          <button class="icon-btn" aria-label={reveal ? "Hide" : "Show"} use:tooltip onclick={() => (reveal = !reveal)}><Icon name={reveal ? "eye-off" : "eye"} /></button>
        </div>
      </div>
    {:else if auth.kind === "bearer"}
      <div class="field">
        <span>Token</span>
        <div class="with-btn">
          <VarField class="input mono" value={auth.token} onchange={(v) => (auth.token = v)} placeholder={"{{token}}"} label="Token" masked={!reveal && !auth.token.startsWith("{{")} {variables} />
          <button class="icon-btn" aria-label={reveal ? "Hide" : "Show"} use:tooltip onclick={() => (reveal = !reveal)}><Icon name={reveal ? "eye-off" : "eye"} /></button>
        </div>
      </div>
    {:else if auth.kind === "apiKey"}
      <div class="field">
        <span>Key</span>
        <VarField class="input mono" value={auth.keyName} onchange={(v) => (auth.keyName = v)} placeholder="X-API-Key" label="Key" invalid={!!keyNameError} {variables} />
        {#if keyNameError}<span class="field-error" role="alert">{keyNameError}</span>{/if}
      </div>
      <div class="field">
        <span>Value</span>
        <VarField class="input mono" value={auth.keyValue} onchange={(v) => (auth.keyValue = v)} placeholder={"{{apiKey}}"} label="Value" {variables} />
      </div>
      <div class="field">
        <span>Add to</span>
        <Select class="auth-select" options={locations} value={auth.keyLocation} onchange={(v) => (auth.keyLocation = v)} label="Add to" />
      </div>
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
  .field :global(.var-field),
  .field :global(.auth-select) {
    width: 100%;
    color: var(--text);
  }
  .field-error {
    color: var(--danger);
    font-size: 11.5px;
  }
  .field :global(.var-field:has([aria-invalid="true"])) {
    border-color: var(--danger);
  }
  .with-btn {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .with-btn :global(.var-field) {
    flex: 1;
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
