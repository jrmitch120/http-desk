<script lang="ts">
  // Application settings: appearance, request defaults, TLS, response limits.
  import { open } from "@tauri-apps/plugin-dialog";
  import { getVersion } from "@tauri-apps/api/app";
  import { updates } from "../lib/updates.svelte";
  import { app } from "../lib/store.svelte";
  import type { AppSettings, ExecSettings } from "../lib/types";
  import Banner from "./Banner.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Modal from "./Modal.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import Toggle from "./Toggle.svelte";

  let copy = $state<AppSettings | null>(app.settings ? structuredClone($state.snapshot(app.settings) as AppSettings) : null);
  let saving = $state(false);
  let version = $state("");
  getVersion().then((v) => (version = v)).catch(() => {});

  const themes: { value: AppSettings["theme"]; label: string; icon: string }[] = [
    { value: "dark", label: "Dark", icon: "moon" },
    { value: "light", label: "Light", icon: "sun" },
  ];
  const layouts: { value: AppSettings["layout"]; label: string; icon: string }[] = [
    { value: "horizontal", label: "Response on the right", icon: "columns" },
    { value: "vertical", label: "Response below", icon: "rows" },
  ];

  type PathKey = "caCertPath" | "clientCertPath" | "clientKeyPath";

  function num(e: Event, min = 0): number {
    const n = Number((e.currentTarget as HTMLInputElement).value);
    return Number.isFinite(n) ? Math.max(min, n) : min;
  }

  function setPath(key: PathKey, value: string) {
    if (copy) copy.exec[key] = value.trim() === "" ? null : value;
  }

  async function browse(key: PathKey) {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "Certificates & keys", extensions: ["pem", "crt", "cer", "der", "key"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof picked === "string") setPath(key, picked);
  }

  async function save() {
    if (!copy) return;
    saving = true;
    try {
      if (await app.updateSettings(copy)) app.modal = null;
    } finally {
      saving = false;
    }
  }

  function close() {
    if (app.dialog) return;
    app.modal = null;
  }

  const pathFields: { key: PathKey; label: string; hint: string }[] = [
    { key: "caCertPath", label: "CA certificate", hint: "Extra trusted root (PEM or DER)" },
    { key: "clientCertPath", label: "Client certificate", hint: "For mutual TLS (PEM)" },
    { key: "clientKeyPath", label: "Client key", hint: "Private key for the client certificate (PEM)" },
  ];
</script>

{#snippet pathRow(exec: ExecSettings, f: { key: PathKey; label: string; hint: string })}
  <div class="setting col">
    <div class="label">
      <span>{f.label}</span>
      <small class="muted">{f.hint}</small>
    </div>
    <div class="row">
      <input class="input mono grow" value={exec[f.key] ?? ""} placeholder="None" oninput={(e) => setPath(f.key, e.currentTarget.value)} />
      <button class="btn small" onclick={() => browse(f.key)}>Browse…</button>
      {#if exec[f.key]}
        <button class="icon-btn" aria-label="Clear" use:tooltip onclick={() => setPath(f.key, "")}><Icon name="x" size={13} /></button>
      {/if}
    </div>
  </div>
{/snippet}

<Modal title="Settings" width="560px" onclose={close}>
  {#if copy}
    <div class="body">
      <section>
        <h3>Appearance</h3>
        <div class="setting">
          <div class="label"><span>Theme</span></div>
          <SegmentedControl label="Theme" options={themes} value={copy.theme} onchange={(v) => (copy!.theme = v)} />
        </div>
        <div class="setting">
          <div class="label"><span>Layout</span></div>
          <SegmentedControl label="Layout" options={layouts} value={copy.layout} onchange={(v) => (copy!.layout = v)} />
        </div>
        <div class="setting">
          <div class="label"><span>Show parameter descriptions</span><small class="muted">Under each query param and header; click one to edit it</small></div>
          <Toggle ariaLabel="Show parameter descriptions" checked={copy.showDescriptions} onchange={(v) => (copy!.showDescriptions = v)} />
        </div>
      </section>

      <section>
        <h3>Updates</h3>
        <div class="setting">
          <div class="label"><span>Check for updates on startup</span><small class="muted">{version ? `HttpDesk ${version}` : "HttpDesk"}</small></div>
          <Toggle ariaLabel="Check for updates on startup" checked={copy.checkUpdates} onchange={(v) => (copy!.checkUpdates = v)} />
        </div>
        <div class="setting">
          <div class="label"><span>Check now</span><small class="muted">Downloads come from the project's GitHub releases</small></div>
          <button class="btn small" disabled={updates.checking || updates.progress !== null} onclick={() => updates.check(true)}>
            {updates.checking ? "Checking…" : "Check for updates"}
          </button>
        </div>
      </section>

      <section>
        <h3>Requests</h3>
        <div class="setting">
          <div class="label"><span>Idle timeout</span><small class="muted">Longest wait for the next data from the server, in seconds; 0 disables it. Downloads that keep streaming are never cut off.</small></div>
          <div class="unit">
            <input class="input num" type="number" min="0" step="1" value={copy.exec.timeoutMs / 1000} oninput={(e) => (copy!.exec.timeoutMs = Math.round(num(e) * 1000))} />
            <span class="muted">s</span>
          </div>
        </div>
        <div class="setting">
          <div class="label"><span>Connection timeout</span><small class="muted">Longest wait to connect, in seconds; 0 disables it</small></div>
          <div class="unit">
            <input class="input num" type="number" min="0" step="1" value={copy.exec.connectTimeoutMs / 1000} oninput={(e) => (copy!.exec.connectTimeoutMs = Math.round(num(e) * 1000))} />
            <span class="muted">s</span>
          </div>
        </div>
        <div class="setting">
          <div class="label"><span>Follow redirects</span></div>
          <Toggle ariaLabel="Follow redirects" checked={copy.exec.followRedirects} onchange={(v) => (copy!.exec.followRedirects = v)} />
        </div>
        <div class="setting">
          <div class="label"><span>Maximum redirects</span></div>
          <input class="input num" type="number" min="0" step="1" disabled={!copy.exec.followRedirects} value={copy.exec.maxRedirects} oninput={(e) => (copy!.exec.maxRedirects = Math.round(num(e)))} />
        </div>
        <p class="note muted">Per-request <span class="mono"># @timeout</span>, <span class="mono"># @connection-timeout</span> and <span class="mono"># @no-redirect</span> directives override these defaults.</p>
      </section>

      <section>
        <h3>TLS</h3>
        <div class="setting">
          <div class="label"><span>Verify server certificates</span></div>
          <Toggle ariaLabel="Verify server certificates" checked={copy.exec.verifyTls} onchange={(v) => (copy!.exec.verifyTls = v)} />
        </div>
        {#if !copy.exec.verifyTls}
          <Banner severity="warning" inline class="tls-off">Certificate verification is off. Responses could come from an impostor server — only use this for local development.</Banner>
        {/if}
        {#each pathFields as f (f.key)}
          {@render pathRow(copy.exec, f)}
        {/each}
        <p class="note muted">Environment-specific client certificates can also be set with <span class="mono">SSLConfiguration</span> in <span class="mono">http-client.env.json</span>.</p>
      </section>

      <section>
        <h3>Responses</h3>
        <div class="setting">
          <div class="label"><span>Maximum body size</span><small class="muted">Larger responses are truncated</small></div>
          <div class="unit">
            <input
              class="input num"
              type="number"
              min="1"
              step="1"
              value={Math.round(copy.exec.maxBodyBytes / 1024 / 1024)}
              oninput={(e) => (copy!.exec.maxBodyBytes = Math.round(num(e, 1) * 1024 * 1024))}
            />
            <span class="muted">MB</span>
          </div>
        </div>
      </section>
    </div>
  {:else}
    <div class="empty-state">Settings are not available.</div>
  {/if}

  {#snippet footer()}
    <button class="btn" onclick={close}>Cancel</button>
    <button class="btn primary" disabled={!copy || saving} onclick={save}>Save</button>
  {/snippet}
</Modal>

<style>
  .body {
    padding: 6px 20px 16px;
  }
  section {
    padding: 12px 0 8px;
    border-bottom: 1px solid var(--border);
  }
  section:last-child {
    border-bottom: none;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .setting {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    min-height: 40px;
  }
  .setting.col {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .label {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .label small {
    font-size: 11.5px;
  }
  .grow {
    flex: 1;
  }
  .unit {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .num {
    width: 84px;
    text-align: right;
  }
  .note {
    margin: 4px 0 6px;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .body :global(.tls-off) {
    margin: 2px 0 6px;
  }
</style>
