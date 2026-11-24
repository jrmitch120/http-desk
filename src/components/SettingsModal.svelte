<script lang="ts">
  // Application settings: appearance, portability, request defaults, TLS, response limits, History, Trusted workspaces.
  // A section can be a component of its own (HistorySettings): the styles below reach into it.
  import { open } from "@tauri-apps/plugin-dialog";
  import { getVersion } from "@tauri-apps/api/app";
  import { updates } from "../lib/updates.svelte";
  import { app } from "../lib/store.svelte";
  import type { AppSettings, ExecSettings } from "../lib/types";
  import Banner from "./Banner.svelte";
  import HistorySettings from "./HistorySettings.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Modal from "./Modal.svelte";
  import NumberField from "./NumberField.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import { THEMES } from "../lib/themes";
  import { RESPONSE_POSITIONS } from "../lib/responsePositions";
  import { EDITOR_NAMES, EDITORS, type EditorName } from "../lib/checks";
  import Toggle from "./Toggle.svelte";

  // Edits apply straight to the live settings, through the same save path as the
  // top bar: switches on click, text and number fields on blur or Enter.
  const settings = $derived(app.settings);
  let version = $state("");
  getVersion().then((v) => (version = v)).catch(() => {});

  // Opened from a fix-it button (a TLS send error): start at that section.
  let tlsSection: HTMLElement | undefined = $state();
  $effect(() => {
    if (app.settingsSection === "tls" && tlsSection) {
      tlsSection.scrollIntoView({ block: "start" });
      app.settingsSection = null;
    }
  });

  type PathKey = "caCertPath" | "clientCertPath" | "clientKeyPath";

  function set(patch: Partial<AppSettings>) {
    app.updateSettings(patch);
  }

  /** Whether either editor is turned on in Settings → Portability: else no notes show, so their level means nothing. */
  const editorsOn = $derived(EDITORS.some((e) => app.portability.editors[e]));

  function setEditor(editor: EditorName, on: boolean) {
    set({ portabilityEditors: { ...app.portability.editors, [editor]: on } });
  }

  function setExec(patch: Partial<ExecSettings>) {
    if (!app.settings) return;
    const exec = { ...app.settings.exec, ...patch };
    if (Object.entries(patch).some(([k, v]) => app.settings!.exec[k as keyof ExecSettings] !== v)) set({ exec });
  }

  function setPath(key: PathKey, value: string) {
    setExec({ [key]: value.trim() === "" ? null : value });
  }

  /** Path fields apply on blur and Enter, not per keystroke. */
  function onPathKeydown(e: KeyboardEvent, key: PathKey) {
    if (e.key === "Enter") setPath(key, (e.currentTarget as HTMLInputElement).value);
  }

  async function browse(key: PathKey) {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "Certificates & keys", extensions: ["pem", "crt", "cer", "der", "key"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof picked === "string") setPath(key, picked);
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
      <input class="input mono grow" value={exec[f.key] ?? ""} placeholder="None" onblur={(e) => setPath(f.key, e.currentTarget.value)} onkeydown={(e) => onPathKeydown(e, f.key)} />
      <button class="btn small" onclick={() => browse(f.key)}>Browse…</button>
      {#if exec[f.key]}
        <button class="icon-btn" aria-label="Clear" use:tooltip onclick={() => setPath(f.key, "")}><Icon name="x" size={13} /></button>
      {/if}
    </div>
  </div>
{/snippet}

<Modal title="Settings" width="560px" onclose={close}>
  {#if settings}
    <div class="body">
      <section>
        <h3>Appearance</h3>
        <div class="setting">
          <div class="label"><span>Theme</span></div>
          <SegmentedControl label="Theme" options={THEMES} value={app.themeChoice} onchange={(v) => set({ theme: v })} />
        </div>
        <div class="setting">
          <div class="label"><span>Response position</span></div>
          <SegmentedControl label="Response position" options={RESPONSE_POSITIONS} value={app.responsePosition} onchange={(v) => void app.setResponsePosition(v)} />
        </div>
        <div class="setting">
          <div class="label"><span>Show parameter descriptions</span><small class="muted">Under each query param and header; click one to edit it</small></div>
          <Toggle ariaLabel="Show parameter descriptions" checked={settings.showDescriptions} onchange={(v) => set({ showDescriptions: v })} />
        </div>
      </section>

      <section>
        <h3>Portability</h3>
        {#each EDITORS as editor (editor)}
          <div class="setting">
            <div class="label">
              <span>{EDITOR_NAMES[editor]}</span>
              <small class="muted">Mark lines of <span class="mono">.http</span> files that behave differently in {EDITOR_NAMES[editor]}, for files you share with it</small>
            </div>
            <Toggle ariaLabel={EDITOR_NAMES[editor]} checked={app.portability.editors[editor]} onchange={(v) => setEditor(editor, v)} />
          </div>
        {/each}
        <div class="setting">
          <div class="label">
            <span>Show portability notes as warnings</span>
            <small class="muted">
              {#if editorsOn}
                For teams whose <span class="mono">.http</span> files must work in the editors above. The lines they read differently are marked as warnings; they never block a send.
              {:else}
                Turn on an editor above
              {/if}
            </small>
          </div>
          <Toggle ariaLabel="Show portability notes as warnings" disabled={!editorsOn} checked={settings.portabilityWarnings === true} onchange={(v) => set({ portabilityWarnings: v })} />
        </div>
      </section>

      <section>
        <h3>Updates</h3>
        <div class="setting">
          <div class="label"><span>Check for updates on startup</span><small class="muted">{version ? `HttpDesk ${version}` : "HttpDesk"}</small></div>
          <Toggle ariaLabel="Check for updates on startup" checked={settings.checkUpdates} onchange={(v) => set({ checkUpdates: v })} />
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
          <NumberField label="Idle timeout" unit="s" min={0} value={settings.exec.timeoutMs / 1000} onchange={(v) => setExec({ timeoutMs: Math.round(v * 1000) })} />
        </div>
        <div class="setting">
          <div class="label"><span>Connection timeout</span><small class="muted">Longest wait to connect, in seconds; 0 disables it</small></div>
          <NumberField label="Connection timeout" unit="s" min={0} value={settings.exec.connectTimeoutMs / 1000} onchange={(v) => setExec({ connectTimeoutMs: Math.round(v * 1000) })} />
        </div>
        <div class="setting">
          <div class="label"><span>Follow redirects</span></div>
          <Toggle ariaLabel="Follow redirects" checked={settings.exec.followRedirects} onchange={(v) => setExec({ followRedirects: v })} />
        </div>
        <div class="setting">
          <div class="label"><span>Maximum redirects</span></div>
          <NumberField label="Maximum redirects" integer min={0} disabled={!settings.exec.followRedirects} value={settings.exec.maxRedirects} onchange={(v) => setExec({ maxRedirects: v })} />
        </div>
        <p class="note muted">Per-request <span class="mono"># @timeout</span>, <span class="mono"># @connection-timeout</span> and <span class="mono"># @no-redirect</span> directives override these defaults.</p>
      </section>

      <section aria-labelledby="settings-tls" bind:this={tlsSection}>
        <h3 id="settings-tls">TLS</h3>
        <div class="setting">
          <div class="label"><span>Verify server certificates</span></div>
          <Toggle ariaLabel="Verify server certificates" checked={settings.exec.verifyTls} onchange={(v) => setExec({ verifyTls: v })} />
        </div>
        {#if !settings.exec.verifyTls}
          <Banner severity="warning" inline class="tls-off">Certificate verification is off. Responses could come from an impostor server — only use this for local development.</Banner>
        {/if}
        {#each pathFields as f (f.key)}
          {@render pathRow(settings.exec, f)}
        {/each}
        <p class="note muted">Environment-specific client certificates can also be set with <span class="mono">SSLConfiguration</span> in <span class="mono">http-client.env.json</span>.</p>
      </section>

      <section>
        <h3>Responses</h3>
        <div class="setting">
          <div class="label"><span>Maximum body size</span><small class="muted">Larger responses are truncated</small></div>
          <NumberField
            label="Maximum body size"
            unit="MB"
            integer
            min={1}
            value={Math.round(settings.exec.maxBodyBytes / 1024 / 1024)}
            onchange={(v) => setExec({ maxBodyBytes: v * 1024 * 1024 })}
          />
        </div>
      </section>

      <HistorySettings />

      <section aria-labelledby="settings-trust">
        <h3 id="settings-trust">Trusted workspaces</h3>
        {#each settings.trustedWorkspaces ?? [] as path (path)}
          <div class="setting" data-testid="trusted-workspace">
            <div class="label"><span class="mono selectable">{path}</span>{#if path === app.root}<small class="muted">The open workspace</small>{/if}</div>
            <button class="btn small" onclick={() => app.revokeTrust(path)}>Revoke</button>
          </div>
        {:else}
          <p class="note muted">No workspace is trusted yet.</p>
        {/each}
        <p class="note muted">Scripts in a workspace's <span class="mono">.http</span> files run only once you trust it. HttpDesk asks the first time a send would run one, and keeps the answer here, never in the workspace.</p>
      </section>
    </div>
  {:else}
    <div class="empty-state">Settings are not available.</div>
  {/if}

  {#snippet footer()}
    <button class="btn primary" onclick={close}>Done</button>
  {/snippet}
</Modal>

<style>
  .body {
    padding: 6px 20px 16px;
  }
  .body :global(section) {
    padding: 12px 0 8px;
    border-bottom: 1px solid var(--border);
  }
  .body :global(section:last-child) {
    border-bottom: none;
  }
  .body :global(h3) {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .body :global(.setting) {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    min-height: 40px;
  }
  .body :global(.setting.col) {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .body :global(.label) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .body :global(.label small) {
    font-size: 11.5px;
  }
  .body :global(.grow) {
    flex: 1;
  }
  .body :global(.note) {
    margin: 4px 0 6px;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .body :global(.tls-off) {
    margin: 2px 0 6px;
  }
</style>
