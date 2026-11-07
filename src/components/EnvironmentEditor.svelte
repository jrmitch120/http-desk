<script lang="ts">
  // Graphical editor for http-client.env.json / http-client.private.env.json.
  import { api, errorMessage } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import type { EnvironmentSet, EnvironmentSettings, EnvVar } from "../lib/types";
  import { ENV_COLORS, envColor, envColorShade } from "../lib/envColors";
  import Badge from "./Badge.svelte";
  import Banner from "./Banner.svelte";
  import Checkbox from "./Checkbox.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import Icon from "./Icon.svelte";
  import KeyValueGrid, { type Column, type GridCell } from "./KeyValueGrid.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Modal from "./Modal.svelte";

  const SHARED = "$shared";

  function clean(s: EnvironmentSet): EnvironmentSet {
    const vars = (list: EnvVar[]) =>
      list.filter((v) => v.name.trim() !== "").map((v) => ({ name: v.name.trim(), value: v.value, secret: v.secret, jsonType: v.jsonType }));
    return {
      shared: vars(s.shared),
      environments: s.environments.map((e) => ({ name: e.name, variables: vars(e.variables) })),
      privateFileIgnored: s.privateFileIgnored,
    };
  }

  const initial: EnvironmentSet = app.envSet
    ? structuredClone($state.snapshot(app.envSet) as EnvironmentSet)
    : { shared: [], environments: [], privateFileIgnored: null };
  /** What's on disk, to tell unsaved edits apart. */
  let savedJson = $state(JSON.stringify(clean(initial)));

  let set = $state<EnvironmentSet>(initial);
  let selected = $state<string>(
    app.envName && initial.environments.some((e) => e.name === app.envName) ? app.envName : (initial.environments[0]?.name ?? SHARED),
  );
  /** Environment that should be active after saving (tracks renames/deletes). */
  let activeEnv = $state<string | null>(app.envName);
  let filter = $state("");
  /** Secrets whose value is shown in plain text. */
  const revealed = new SvelteSet<EnvVar>();
  let saving = $state(false);

  const selectedEnv = $derived(selected === SHARED ? undefined : set.environments.find((e) => e.name === selected));
  const vars = $derived(selectedEnv?.variables ?? set.shared);
  function setVars(list: EnvVar[]) {
    if (selectedEnv) selectedEnv.variables = list;
    else set.shared = list;
  }
  /** Production and colour per environment name. Saved to the app settings, not
   *  the env files; renames and deletes below carry or drop them. */
  let meta = $state<Record<string, EnvironmentSettings>>(
    Object.fromEntries(initial.environments.map((e) => [e.name, { ...app.environmentSettings(e.name) }])),
  );
  /** The settings to save: the environments in the list, with what's set. */
  function cleanMeta(): Record<string, EnvironmentSettings> {
    const out: Record<string, EnvironmentSettings> = {};
    for (const { name } of set.environments) {
      const m = meta[name];
      const color = envColor(m?.color);
      if (m?.production || color) out[name] = { production: !!m?.production, color };
    }
    return out;
  }
  let savedMetaJson = $state(JSON.stringify(cleanMeta()));
  function setMeta(name: string, patch: EnvironmentSettings) {
    meta[name] = { ...meta[name], ...patch };
  }
  const colorOptions: SelectOption[] = [{ value: "", label: "No colour" }, ...ENV_COLORS.map((c) => ({ value: c.value, label: c.label, color: envColorShade(c.value, app.effectiveTheme) }))];

  const dirty = $derived(
    JSON.stringify(clean($state.snapshot(set) as EnvironmentSet)) !== savedJson || JSON.stringify(cleanMeta()) !== savedMetaJson || activeEnv !== app.envName,
  );
  const hasSecrets = $derived(set.shared.some((v) => v.secret) || set.environments.some((e) => e.variables.some((v) => v.secret)));

  /** The filter matches names, and the values of shareable variables (never a Secret's). */
  const matches = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return (v: EnvVar) => !q || v.name.toLowerCase().includes(q) || (!v.secret && v.value.toLowerCase().includes(q));
  });
  const blankVar = (): EnvVar => ({ name: "", value: "", secret: false });
  const valueColumn: Column<EnvVar> = { id: "value", header: "Value", width: "1fr", cell: valueCell };
  const lockColumn: Column<EnvVar> = { id: "secret", header: "", width: "34px", cell: lockCell };

  function countOf(list: EnvVar[]) {
    return list.filter((v) => v.name.trim()).length;
  }

  function nameTaken(name: string, except?: string) {
    return name === SHARED || set.environments.some((e) => e.name === name && e.name !== except);
  }

  async function addEnv() {
    const name = (await app.prompt("New environment", "", "e.g. dev, staging, production"))?.trim();
    if (!name) return;
    if (nameTaken(name)) return app.toast("error", `An environment named "${name}" already exists`);
    set.environments.push({ name, variables: [] });
    selected = name;
  }

  async function renameEnv(name: string) {
    const next = (await app.prompt("Rename environment", name))?.trim();
    if (!next || next === name) return;
    if (nameTaken(next, name)) return app.toast("error", `An environment named "${next}" already exists`);
    const env = set.environments.find((e) => e.name === name);
    if (!env) return;
    env.name = next;
    if (meta[name]) {
      meta[next] = meta[name];
      delete meta[name];
    }
    if (selected === name) selected = next;
    if (activeEnv === name) activeEnv = next;
  }

  function duplicateEnv(name: string) {
    const env = set.environments.find((e) => e.name === name);
    if (!env) return;
    let copy = `${name} copy`;
    for (let n = 2; nameTaken(copy); n++) copy = `${name} copy ${n}`;
    set.environments.splice(set.environments.indexOf(env) + 1, 0, { name: copy, variables: structuredClone($state.snapshot(env.variables) as EnvVar[]) });
    // A copy of production is production too, until the user says otherwise.
    if (meta[name]) meta[copy] = { ...meta[name] };
    selected = copy;
  }

  async function deleteEnv(name: string) {
    const r = await app.choose("Delete environment", `Delete environment "${name}" and all of its variables?`, [
      { label: "Cancel", value: "cancel" },
      { label: "Delete", value: "delete", danger: true },
    ]);
    if (r.button !== "delete") return;
    set.environments = set.environments.filter((e) => e.name !== name);
    delete meta[name];
    if (selected === name) selected = set.environments[0]?.name ?? SHARED;
    if (activeEnv === name) activeEnv = null;
  }

  /** Whether an environment of this name is saved; sending only sees saved ones. */
  const onDisk = (name: string) => !!app.envSet?.environments.some((e) => e.name === name);

  /** Switches to the environment right away. One that isn't saved yet (new or
   *  renamed) is saved first, along with the other edits, so it can be used. */
  async function useEnv(name: string) {
    if (!onDisk(name) && !(await persist())) return;
    activeEnv = name;
    await app.selectEnvironment(name);
  }

  async function persist(): Promise<boolean> {
    saving = true;
    try {
      const cleaned = clean($state.snapshot(set) as EnvironmentSet);
      const report = await api.saveEnvironments(cleaned);
      savedJson = JSON.stringify(cleaned);
      if (report.gitignoreUpdated) app.toast("info", "Added http-client.private.env.json to .gitignore");
      await app.loadEnvironments();
      // Production and colour go to the app settings (a failed save is reported there).
      const settings = cleanMeta();
      if (!(await app.saveEnvironmentSettings(settings))) return false;
      savedMetaJson = JSON.stringify(settings);
      app.toast("success", "Environments saved");
      return true;
    } catch (e) {
      app.toast("error", `Could not save environments: ${errorMessage(e)}`);
      return false;
    } finally {
      saving = false;
    }
  }

  async function save() {
    if (!(await persist())) return;
    if (activeEnv !== app.envName) await app.selectEnvironment(activeEnv);
    app.modal = null;
  }

  async function requestClose() {
    if (app.dialog) return; // a nested prompt/confirm is handling this keypress
    if (dirty) {
      const r = await app.choose("Discard changes?", "You have unsaved environment changes.", [
        { label: "Cancel", value: "cancel" },
        { label: "Discard", value: "discard", danger: true },
      ]);
      if (r.button !== "discard") return;
    }
    app.modal = null;
  }
</script>

{#snippet valueCell({ row, ghost, set: setRow }: GridCell<EnvVar>)}
  {@const shown = !row.secret || revealed.has(row)}
  <input class="cell" type={shown ? "text" : "password"} value={row.value} placeholder="Value" spellcheck="false" oninput={(e) => setRow({ value: e.currentTarget.value })} />
  {#if row.secret && !ghost}
    <button class="icon-btn reveal" aria-label={shown ? "Hide value" : "Show value"} use:tooltip onclick={() => (shown ? revealed.delete(row) : revealed.add(row))}>
      <Icon name={shown ? "eye-off" : "eye"} size={13} />
    </button>
  {/if}
{/snippet}

{#snippet lockCell({ row, ghost, set: setRow }: GridCell<EnvVar>)}
  {#if !ghost}
    <button
      class="icon-btn lock"
      class:active={row.secret}
      aria-label="Secret"
      aria-pressed={row.secret}
      use:tooltip={row.secret
        ? "Secret: saved only in http-client.private.env.json. Click to make it shareable."
        : "Shareable: saved in http-client.env.json. Click to make it a Secret."}
      onclick={() => setRow({ secret: !row.secret })}
    >
      <Icon name={row.secret ? "lock" : "unlock"} size={13} />
    </button>
  {/if}
{/snippet}

<Modal title="Environments" width="860px" height="560px" onclose={requestClose}>
  <div class="layout">
    <aside>
      <div class="side-head">
        <span class="muted">Environments</span>
        <button class="icon-btn" aria-label="New environment" use:tooltip onclick={addEnv}><Icon name="plus" /></button>
      </div>
      <div class="list">
        <button class="env" class:selected={selected === SHARED} onclick={() => (selected = SHARED)}>
          <Icon name="globe" size={14} />
          <span class="ellipsis grow">Shared variables</span>
          <span class="count">{countOf(set.shared)}</span>
        </button>
        <div class="divider"></div>
        {#each set.environments as env (env.name)}
          {@const color = envColor(meta[env.name]?.color)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="env" class:selected={selected === env.name} onclick={() => (selected = env.name)} ondblclick={() => renameEnv(env.name)} role="button" tabindex="0">
            <span class="env-icon" style:color={color ? envColorShade(color, app.effectiveTheme) : null}><Icon name="layers" size={14} /></span>
            <span class="ellipsis grow">{env.name}</span>
            {#if meta[env.name]?.production}<Badge tone="danger">Prod</Badge>{/if}
            {#if activeEnv === env.name}<Badge tone="success">Active</Badge>{/if}
            <span class="count">{countOf(env.variables)}</span>
          </div>
        {:else}
          <div class="none muted">No environments yet.<br /><button class="link" onclick={addEnv}>Create one</button></div>
        {/each}
      </div>
    </aside>

    <section class="main">
      <div class="main-head">
        <div class="title">
          {#if selected === SHARED}
            <strong>Shared variables</strong>
            <span class="muted">Available in every environment (<span class="mono">$shared</span>)</span>
          {:else}
            <strong class="ellipsis">{selected}</strong>
          {/if}
        </div>
        <div class="spacer"></div>
        {#if selected !== SHARED}
          {@const inUse = activeEnv === selected && app.envName === selected}
          <button
            class="btn small"
            disabled={saving || inUse}
            onclick={() => useEnv(selected)}
            use:tooltip={onDisk(selected) ? "Select this environment for sending requests" : "Save environments and select this one for sending requests"}
          >
            <Icon name="check" size={13} />{inUse ? "In use" : onDisk(selected) ? "Use" : "Save & use"}
          </button>
          <button class="icon-btn" aria-label="Rename" use:tooltip onclick={() => renameEnv(selected)}><Icon name="edit" size={14} /></button>
          <button class="icon-btn" aria-label="Duplicate" use:tooltip onclick={() => duplicateEnv(selected)}><Icon name="copy" size={14} /></button>
          <button class="icon-btn danger-hover" aria-label="Delete" use:tooltip onclick={() => deleteEnv(selected)}><Icon name="trash" size={14} /></button>
        {/if}
        <div class="filter">
          <Icon name="search" size={13} />
          <input class="input" placeholder="Filter variables" bind:value={filter} />
        </div>
      </div>

      {#if selectedEnv}
        {@const name = selectedEnv.name}
        <div class="env-options">
          <Checkbox
            checked={!!meta[name]?.production}
            onchange={(on) => setMeta(name, { production: on })}
            tooltip="Ask before sending anything but GET, HEAD or OPTIONS with this environment"
          >
            Production
          </Checkbox>
          <span class="muted">Colour</span>
          <Select
            class="env-color"
            options={colorOptions}
            value={envColor(meta[name]?.color) ?? ""}
            onchange={(v) => setMeta(name, { color: v || null })}
            label="Colour"
            tooltip="Tints the environment picker in the top bar"
          />
          <span class="hint muted">Kept in HttpDesk's settings, not in the env files</span>
        </div>
      {/if}

      {#if hasSecrets && set.privateFileIgnored === false}
        <Banner severity="warning">
          <span class="mono">http-client.private.env.json</span> is not ignored by git. Secrets could be committed — add it to <span class="mono">.gitignore</span>.
        </Banner>
      {/if}

      <div class="vars">
        <KeyValueGrid
          bind:items={() => vars, setVars}
          columns={[{ id: "name", width: "34%" }, valueColumn, lockColumn, "delete"]}
          blank={blankVar}
          label="Variables"
          visible={matches}
          bulkEdit={false}
          namePlaceholder="Variable"
        />
      </div>
    </section>
  </div>

  {#snippet footer()}
    <span class="hint muted">
      Saved to <span class="mono">http-client.env.json</span> (shared) and <span class="mono">http-client.private.env.json</span> (secrets)
    </span>
    <div class="spacer"></div>
    <button class="btn" onclick={requestClose}>Cancel</button>
    <button class="btn primary" disabled={saving || !dirty} onclick={save}>{saving ? "Saving…" : "Save"}</button>
  {/snippet}
</Modal>

<style>
  .layout {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  aside {
    width: 220px;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--panel-2);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 6px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .list {
    overflow: auto;
    padding: 0 6px 8px;
    flex: 1;
  }
  .env {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: none;
    border-radius: 5px;
    color: var(--text-2);
    text-align: left;
    cursor: pointer;
  }
  .env:hover {
    background: var(--hover);
  }
  .env.selected {
    background: var(--accent-soft);
    color: var(--text);
  }
  .env :global(svg) {
    color: var(--muted);
    flex: none;
  }
  /* Shows the environment's colour, when it has one. */
  .env-icon {
    display: flex;
    flex: none;
    color: var(--muted);
  }
  .env .env-icon :global(svg) {
    color: inherit;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .env-options {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  .env-options > .muted {
    margin-left: 10px;
  }
  .env-options :global(.env-color) {
    min-width: 130px;
  }
  .env-options .hint {
    margin-left: auto;
  }
  .count {
    font-size: 11px;
    color: var(--faint);
  }
  .divider {
    height: 1px;
    background: var(--border);
    margin: 6px 4px;
  }
  .none {
    padding: 14px 10px;
    font-size: 12px;
    line-height: 1.7;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .main-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title .muted {
    font-size: 11.5px;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 6px;
    color: var(--muted);
  }
  .filter .input {
    height: 26px;
    width: 160px;
  }
  .danger-hover:hover {
    color: var(--danger);
  }
  .vars {
    flex: 1;
    overflow: auto;
    padding: 10px 14px 14px;
  }
  .reveal,
  .lock {
    align-self: center;
    flex: none;
    width: 24px;
    height: 24px;
  }
  .reveal {
    margin-right: 4px;
  }
  .lock {
    margin: 0 auto;
  }
  .hint {
    font-size: 11.5px;
  }
</style>
