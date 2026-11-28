<script lang="ts">
  // Application settings, in six categories: a rail of tabs down the left (owned markup,
  // ADR 0002) and the selected category's page on the right, the only part that scrolls.
  // The rail is a vertical tablist (`use:rovingTabs`): only the selected tab is a Tab
  // stop, the arrow keys and Home/End select and focus, and Tab goes on into the page.
  // A page can be a component of its own (HistorySettings): the styles below reach into it.
  import { open } from "@tauri-apps/plugin-dialog";
  import { getVersion } from "@tauri-apps/api/app";
  import { updates } from "../lib/updates.svelte";
  import { app, type SettingsCategory } from "../lib/store.svelte";
  import type { AppSettings, ExecSettings } from "../lib/types";
  import Banner from "./Banner.svelte";
  import HistorySettings from "./HistorySettings.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { rovingTabs } from "../lib/rovingTabs";
  import Modal from "./Modal.svelte";
  import NumberField from "./NumberField.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import { THEMES } from "../lib/themes";
  import { RESPONSE_POSITIONS } from "../lib/responsePositions";
  import { EDITOR_NAMES, EDITORS, type EditorName } from "../lib/checks";
  import Toggle from "./Toggle.svelte";
  import { textFieldAttrs } from "../lib/textField";

  /** The rail's categories, in order. */
  const CATEGORIES: { id: SettingsCategory; name: string; icon: string }[] = [
    { id: "general", name: "General", icon: "settings" },
    { id: "requests", name: "Requests", icon: "send" },
    { id: "tls", name: "TLS", icon: "lock" },
    { id: "portability", name: "Portability", icon: "code" },
    { id: "history", name: "History", icon: "history" },
    { id: "trust", name: "Trusted workspaces", icon: "unlock" },
  ];
  const selected = $derived(CATEGORIES.find((c) => c.id === app.settingsCategory) ?? CATEGORIES[0]);
  /** A category's status mark, as the words that describe it: the rail's only one is
   *  TLS while certificate verification is off. */
  const warnings = $derived<Partial<Record<SettingsCategory, string>>>(
    app.settings?.exec.verifyTls === false ? { tls: "Certificate verification is off" } : {},
  );

  // Edits apply straight to the live settings, through the same save path as the
  // top bar: switches on click, text and number fields on blur or Enter.
  const settings = $derived(app.settings);
  let version = $state("");
  getVersion().then((v) => (version = v)).catch(() => {});

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

  function setPath(key: PathKey, value: string | null) {
    setExec({ [key]: value });
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
      <!-- Read-only: a path is chosen with Browse… (where the OS picker also takes a typed
           or pasted path), so it can't be mistyped; it can still be selected and copied.
           Clear sits in the field's end slot, kept whether or not there's a path, so neither
           the field nor Browse… moves and Browse… ends on the page's edge. -->
      <div class="input boxed mono grow">
        <input {...textFieldAttrs} readonly aria-label={f.label} value={exec[f.key] ?? ""} placeholder="None" />
        <span class="input-end button">
          {#if exec[f.key]}
            <button class="icon-btn" aria-label="Clear {f.label}" use:tooltip onclick={() => setPath(f.key, null)}><Icon name="x" size={14} /></button>
          {/if}
        </span>
      </div>
      <button class="btn small" aria-label="Browse for {f.label}" onclick={() => browse(f.key)}>Browse…</button>
    </div>
  </div>
{/snippet}

<Modal title="Settings" width="760px" height="min(540px, calc(100vh - 48px))" onclose={close}>
  {#if settings}
    <div class="body">
      <div class="rail" role="tablist" aria-label="Settings categories" aria-orientation="vertical" use:rovingTabs>
        {#each CATEGORIES as c (c.id)}
          {@const warning = warnings[c.id]}
          <button
            class="list-row"
            class:current={c.id === selected.id}
            role="tab"
            id="settings-tab-{c.id}"
            aria-selected={c.id === selected.id}
            tabindex={c.id === selected.id ? 0 : -1}
            aria-controls="settings-page"
            aria-describedby={warning ? `settings-warning-${c.id}` : undefined}
            onclick={() => (app.settingsCategory = c.id)}
          >
            <Icon name={c.icon} size={16} />
            <span>{c.name}</span>
            {#if warning}<span class="warning-mark" data-testid="warning-mark" aria-hidden="true"></span>{/if}
          </button>
          <!-- The mark's words, outside the tab so they describe it without joining its name. -->
          {#if warning}<span id="settings-warning-{c.id}" hidden>{warning}</span>{/if}
        {/each}
      </div>

      <div class="page" role="tabpanel" id="settings-page" aria-labelledby="settings-tab-{selected.id}">
        <h3>{selected.name}</h3>
        {#if selected.id === "general"}
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
        {:else if selected.id === "requests"}
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
          <p class="note muted">Per-request <span class="mono"># @timeout</span>, <span class="mono"># @connection-timeout</span> and <span class="mono"># @no-redirect</span> directives override these defaults.</p>
        {:else if selected.id === "tls"}
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
        {:else if selected.id === "portability"}
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
        {:else if selected.id === "history"}
          <HistorySettings />
        {:else if selected.id === "trust"}
          {#each settings.trustedWorkspaces ?? [] as path (path)}
            <div class="setting" data-testid="trusted-workspace">
              <div class="label"><span class="mono selectable">{path}</span>{#if path === app.root}<small class="muted">The open workspace</small>{/if}</div>
              <button class="btn small" onclick={() => app.revokeTrust(path)}>Revoke</button>
            </div>
          {:else}
            <p class="note muted">No workspace is trusted yet.</p>
          {/each}
          <p class="note muted">Scripts in a workspace's <span class="mono">.http</span> files run only once you trust it. HttpDesk asks the first time a send would run one, and keeps the answer here, never in the workspace.</p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty-state">Settings are not available.</div>
  {/if}

  {#snippet footer()}
    <button class="btn primary" onclick={close}>Done</button>
  {/snippet}
</Modal>

<style>
  /* The rail stays put; only the page scrolls. */
  .body {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .rail {
    flex: none;
    width: 188px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-2) 0;
    border-right: 1px solid var(--border);
    background: var(--panel-2);
    overflow-y: auto;
  }
  .rail .list-row {
    min-height: 32px;
    gap: 10px;
  }
  .rail .list-row :global(svg) {
    flex: none;
  }
  /* The warning colour, edged in a deeper tone of it so it holds up on the light
     theme's pale rail as well as the dark one. */
  .warning-mark {
    flex: none;
    width: 8px;
    height: 8px;
    margin-left: auto;
    border-radius: 50%;
    background: var(--warning);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--warning) 55%, var(--text));
  }
  .page {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 18px 20px 16px;
  }
  .page h3 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .page :global(.setting) {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    min-height: 40px;
  }
  .page :global(.setting.col) {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .page :global(.label) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .page :global(.label small) {
    font-size: 11.5px;
  }
  .page :global(.grow) {
    flex: 1;
  }
  .page :global(.note) {
    margin: 4px 0 6px;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .page :global(.tls-off) {
    margin: 2px 0 6px;
  }
</style>
