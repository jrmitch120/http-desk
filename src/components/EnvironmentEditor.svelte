<script lang="ts">
  // Graphical editor for http-client.env.json / http-client.private.env.json: one
  // folder's own pair at a time (ADR-0004), picked with the Folder selector.
  import { api, errorMessage } from "../lib/api";
  import { app, type WantedDefinition } from "../lib/store.svelte";
  import type { EnvironmentSet, EnvironmentSettings, EnvVar } from "../lib/types";
  import { ENV_COLORS, envColor, envColorShade } from "../lib/envColors";
  import Badge from "./Badge.svelte";
  import Banner from "./Banner.svelte";
  import Checkbox from "./Checkbox.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import Icon from "./Icon.svelte";
  import KeyValueGrid, { type Column, type GridCell } from "./KeyValueGrid.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { tick, untrack } from "svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Modal from "./Modal.svelte";
  import VarField from "../lib/codemirror/VarField.svelte";
  import { envValueProvider, SHARED } from "../lib/vars";
  import type { Definition } from "../lib/codemirror/setup";
  import SegmentedControl from "./SegmentedControl.svelte";
  import EnvironmentMatrix from "./EnvironmentMatrix.svelte";
  import { addToAllEnvironments, setCell } from "../lib/envMatrix";
  import { lastNamed } from "../lib/http";
  import type { MenuItem } from "../lib/menu.svelte";
  import { environmentsFor, folderLabel, workspaceFolders } from "../lib/envFolders";

  /** Matrix (every environment side by side) unless the user picked the list; remembered in the app settings. */
  const view = $derived(app.settings?.envView === "list" ? "list" : "matrix");
  const viewOptions = [
    { value: "list", label: "List", icon: "rows" },
    { value: "matrix", label: "Matrix", icon: "columns" },
  ] as const;

  function clean(s: EnvironmentSet): EnvironmentSet {
    const vars = (list: EnvVar[]) =>
      list.filter((v) => v.name.trim() !== "").map((v) => ({ name: v.name.trim(), value: v.value, secret: v.secret, jsonType: v.jsonType }));
    return {
      shared: vars(s.shared),
      environments: s.environments.map((e) => ({ name: e.name, variables: vars(e.variables) })),
      privateFileIgnored: s.privateFileIgnored,
    };
  }

  const empty = (): EnvironmentSet => ({ shared: [], environments: [], privateFileIgnored: null });
  const rootPair = (): EnvironmentSet => (app.envSet ? structuredClone($state.snapshot(app.envSet) as EnvironmentSet) : empty());
  const firstSelected = (s: EnvironmentSet) =>
    app.envName && s.environments.some((e) => e.name === app.envName) ? app.envName : (s.environments[0]?.name ?? SHARED);

  // The folder whose own pair of files is shown, relative to the root ("" for the root):
  // where a hover card's Edit points, else the active request's nearest folder with env files.
  const opening = app.definitionWanted;
  const firstFolder = opening?.kind === "env" && opening.dir !== undefined ? opening.dir : app.activeTab ? app.envFolderFor(app.activeTab.path) : "";
  let folder = $state(firstFolder);
  /** True while a folder's files are being read. */
  let loading = $state(false);

  const initial: EnvironmentSet = firstFolder === "" ? rootPair() : empty();
  /** What's on disk, to tell unsaved edits apart. */
  let savedJson = $state(JSON.stringify(clean(initial)));
  /** The environments saved in this folder's files; sending only sees saved ones. */
  const savedNames = $derived((JSON.parse(savedJson) as EnvironmentSet).environments.map((e) => e.name));

  let set = $state<EnvironmentSet>(initial);
  let selected = $state<string>(firstSelected(initial));
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
  /** Below the root, what this folder's requests get from its own files as saved and from farther
   *  folders' files (ADR-0004): values here can refer to those, and their Edit opens the supplying folder. */
  const inherited = $derived(folder === "" ? null : environmentsFor(app.envSet, app.envFolders, folder));
  /** What the values being edited can refer to: the environment shown (as edited, saved or not) and the shared variables.
   *  A hover card's Edit focuses the defining row here (e.g. a shared variable used in an environment's value). */
  const variables = $derived({
    ...envValueProvider(set, inherited, selected),
    edit: (d: Definition) => {
      app.definitionWanted = d;
    },
  });
  /** Production and colour per environment name, for every folder (they're keyed by name).
   *  Saved to the app settings, not the env files; a rename below carries them over, and
   *  an environment no folder has any more drops them when saved. */
  let meta = $state<Record<string, EnvironmentSettings>>({});
  /** The names settings are kept for: every environment in the workspace's files, and this folder's as edited. */
  const metaNames = () => [...new Set([...app.envNames, ...set.environments.map((e) => e.name)])];
  /** The settings to save: the environments in the list, with what's set. */
  function cleanMeta(): Record<string, EnvironmentSettings> {
    const out: Record<string, EnvironmentSettings> = {};
    for (const name of metaNames()) {
      const m = meta[name];
      const color = envColor(m?.color);
      if (m?.production || color) out[name] = { production: !!m?.production, color };
    }
    return out;
  }
  let savedMetaJson = $state("");
  function resetMeta() {
    meta = Object.fromEntries(metaNames().map((name) => [name, { ...app.environmentSettings(name) }]));
    savedMetaJson = JSON.stringify(cleanMeta());
  }
  resetMeta();
  function setMeta(name: string, patch: EnvironmentSettings) {
    meta[name] = { ...meta[name], ...patch };
  }
  const colorOptions: SelectOption[] = [{ value: "", label: "No colour" }, ...ENV_COLORS.map((c) => ({ value: c.value, label: c.label, color: envColorShade(c.value, app.effectiveTheme) }))];

  /** Unsaved edits to the folder's files or to the environments' settings. */
  const filesDirty = $derived(JSON.stringify(clean($state.snapshot(set) as EnvironmentSet)) !== savedJson || JSON.stringify(cleanMeta()) !== savedMetaJson);
  const dirty = $derived(filesDirty || activeEnv !== app.envName);
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
    // In the matrix it's a new column at the end: bring it into view.
    await tick();
    matrix?.revealColumn(name);
  }

  async function renameEnv(name: string) {
    const next = (await app.prompt("Rename environment", name))?.trim();
    if (!next || next === name) return;
    if (nameTaken(next, name)) return app.toast("error", `An environment named "${next}" already exists`);
    const env = set.environments.find((e) => e.name === name);
    if (!env) return;
    env.name = next;
    // Another folder may still have `name`; its settings are dropped on save if none does.
    if (meta[name]) meta[next] = { ...meta[name] };
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
    if (selected === name) selected = set.environments[0]?.name ?? SHARED;
    if (activeEnv === name) activeEnv = null;
  }

  /** Whether an environment of this name is saved in this folder; sending only sees saved ones. */
  const onDisk = (name: string) => savedNames.includes(name);

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
      if (!(await app.writeEnvironments(cleaned, folder))) return false;
      savedJson = JSON.stringify(cleaned);
      // Production and colour go to the app settings (a failed save is reported there).
      const settings = cleanMeta();
      if (!(await app.saveEnvironmentSettings(settings))) return false;
      savedMetaJson = JSON.stringify(settings);
      app.toast("success", "Environments saved");
      return true;
    } finally {
      saving = false;
    }
  }

  async function save() {
    if (!(await persist())) return;
    if (activeEnv !== app.envName) await app.selectEnvironment(activeEnv);
    app.modal = null;
  }

  /** Adds a variable, empty, to every environment that doesn't have it, and focuses its first cell. */
  async function addToAll() {
    const name = (await app.prompt("Add variable to all environments", "", "Variable name"))?.trim();
    if (!name) return;
    if (!addToAllEnvironments(set, name)) return app.toast("info", `Every environment already has "${name}"`);
    filter = "";
    await tick();
    matrix?.focusCell(set.environments[0].name, name);
  }

  // A hover card's Edit: show the environment that supplies the variable, and focus its row
  // (or, in the matrix, its cell). "Add … to <environment>" (the Undefined-variable strip)
  // adds an empty one first.
  let grid = $state<KeyValueGrid<EnvVar>>();
  let matrix = $state<EnvironmentMatrix>();
  /** A definition to focus once its folder is showing. */
  let wanted = $state<(WantedDefinition & { kind: "env" }) | null>(null);
  $effect(() => {
    const want = app.definitionWanted;
    if (want?.kind !== "env") return;
    app.definitionWanted = null;
    untrack(() => void takeWanted(want));
  });
  async function takeWanted(want: WantedDefinition & { kind: "env" }) {
    if (want.dir !== undefined && want.dir !== folder && !(await switchFolder(want.dir))) return;
    wanted = want;
  }
  $effect(() => {
    const want = wanted;
    if (!want || loading || !(grid || matrix)) return;
    wanted = null;
    if (want.env !== SHARED && !set.environments.some((e) => e.name === want.env)) return;
    filter = "";
    if (matrix) {
      // An empty patch adds the variable, empty, only where the column lacks it.
      if (want.add) setCell(set, want.env, want.name, {});
      tick().then(() => matrix?.focusCell(want.env, want.name));
      return;
    }
    selected = want.env;
    if (want.add && !vars.some((v) => v.name === want.name)) setVars([...vars, { name: want.name, value: "", secret: false }]);
    tick().then(() => {
      const row = lastNamed(vars, want.name);
      if (row) grid?.focusValue(row);
    });
  });

  /** The folder's selector label: `api/users/`, or "Workspace root". */
  const folderName = (dir: string) => (dir ? `${dir}/` : "Workspace root");
  /** Where this folder's files are, for the hints: `api/` (nothing at the root). */
  const filePrefix = $derived(folder ? `${folder}/` : "");
  /** The root and every folder with env files; then one being added (no files yet), then the
   *  workspace's other folders, where env files can be added. */
  const folderOptions = $derived.by((): SelectOption[] => {
    const withFiles = ["", ...app.envFolders.map((f) => f.dir)];
    if (!withFiles.includes(folder)) withFiles.push(folder);
    const others = workspaceFolders(app.tree, app.root ?? "").filter((d) => !withFiles.includes(d));
    return [
      ...withFiles.map((d) => ({ value: d, label: folderName(d) })),
      ...others.map((d) => ({ value: d, label: folderName(d), note: "Add environment files here…" })),
    ];
  });

  /** Shows folder `dir`'s own pair of files (read from disk; the root's as the app has it). False if it can't be read. */
  async function openFolder(dir: string): Promise<boolean> {
    loading = true;
    try {
      const next = dir === "" ? rootPair() : await api.loadEnvironments(dir);
      folder = dir;
      set = next;
      savedJson = JSON.stringify(clean(next));
      selected = firstSelected(next);
      filter = "";
      revealed.clear();
      resetMeta();
      return true;
    } catch (e) {
      app.toast("error", `Could not read the environments of ${folderLabel(dir)}: ${errorMessage(e)}`);
      return false;
    } finally {
      loading = false;
    }
  }
  if (firstFolder !== "") {
    void openFolder(firstFolder).then((ok) => {
      if (!ok) void openFolder("");
    });
  }

  /** Switches to folder `dir`, asking first about unsaved changes; false if it stays on this one. */
  async function switchFolder(dir: string): Promise<boolean> {
    if (dir === folder) return true;
    if (filesDirty) {
      const r = await app.choose("Unsaved changes", `Save the changes to the environments of ${folderLabel(folder)} first?`, [
        { label: "Cancel", value: "cancel" },
        { label: "Discard", value: "discard", danger: true },
        { label: "Save", value: "save", primary: true },
      ]);
      if (r.button === "cancel") return false;
      if (r.button === "save" && !(await persist())) return false;
    }
    return openFolder(dir);
  }

  /** Closes the modal, asking first about unsaved changes; false if it stays open. */
  async function requestClose(): Promise<boolean> {
    if (app.dialog || app.renaming) return false; // a nested prompt/confirm/form is handling this keypress
    if (dirty) {
      const r = await app.choose("Discard changes?", "You have unsaved environment changes.", [
        { label: "Cancel", value: "cancel" },
        { label: "Discard", value: "discard", danger: true },
      ]);
      if (r.button !== "discard") return false;
    }
    app.modal = null;
    return true;
  }

  /** Rename variable: renaming saves the env files (and the files referencing it), so
   *  unsaved edits here are saved first, if the user agrees. Afterwards the modal shows
   *  the environments as saved, with the new name. */
  async function renameVariable(name: string) {
    if (dirty) {
      const r = await app.choose("Save changes first?", "Renaming a variable saves the environments. Your unsaved changes to them will be saved too.", [
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "save", primary: true },
      ]);
      if (r.button !== "save" || !(await persist())) return;
    }
    if (!(await app.renameVariable(name, folder))) return;
    await reloadFolder();
  }

  /** Shows this folder's files as saved again (after the store wrote them), keeping the view. */
  async function reloadFolder() {
    try {
      const next = folder === "" ? rootPair() : await api.loadEnvironments(folder);
      set = next;
      savedJson = JSON.stringify(clean(next));
    } catch (e) {
      app.toast("error", `Could not read the environments of ${folderLabel(folder)}: ${errorMessage(e)}`);
    }
  }

  /** A matrix column header's menu: the same Rename, Duplicate and Delete as the List view's buttons. */
  function environmentActions(name: string): MenuItem[] {
    return [
      { label: "Rename…", icon: "edit", action: () => void renameEnv(name) },
      { label: "Duplicate", icon: "copy", action: () => duplicateEnv(name) },
      { separator: true },
      { label: "Delete environment…", icon: "trash", danger: true, action: () => void deleteEnv(name) },
    ];
  }

  /** A matrix row's own actions. Find usages lists, in the sidebar behind this modal, what
   *  references the variable, so it closes the modal (the search reads env files from disk,
   *  so unsaved edits are asked about first). */
  function rowActions(name: string): MenuItem[] {
    return [
      {
        label: "Find usages",
        icon: "search",
        action: async () => {
          if (await requestClose()) void app.findUsages(name);
        },
      },
      { label: "Rename…", icon: "edit", action: () => void renameVariable(name) },
    ];
  }
</script>

{#snippet valueCell({ row, ghost, set: setRow }: GridCell<EnvVar>)}
  {@const shown = !row.secret || revealed.has(row)}
  <VarField class="cell" value={row.value} placeholder="Value" label="Value" masked={!shown} {variables} onchange={(value) => setRow({ value })} />
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

{#snippet secretsWarning()}
  {#if hasSecrets && set.privateFileIgnored === false}
    <Banner severity="warning">
      <span class="mono">{filePrefix}http-client.private.env.json</span> is not ignored by git. Secrets could be committed — add it to <span class="mono">.gitignore</span>.
    </Banner>
  {/if}
{/snippet}

<Modal title="Environments" width="860px" height="560px" onclose={requestClose}>
  <div class="frame">
    <div class="view-bar">
      <Select
        class="env-folder"
        options={folderOptions}
        value={folder}
        onchange={(d) => void switchFolder(d)}
        label="Folder"
        tooltip="Edit the env files of this folder: its requests (and those in its subfolders without env files) use them first"
      />
      <SegmentedControl options={viewOptions} value={view} onchange={(v) => app.updateSettings({ envView: v })} label="View" />
      {#if view === "matrix"}
        <div class="spacer"></div>
        <button class="btn small" disabled={!set.environments.length} onclick={addToAll}>
          <Icon name="plus" size={13} />Add variable to all environments
        </button>
        <div class="filter">
          <Icon name="search" size={13} />
          <input class="input" placeholder="Filter variables" bind:value={filter} />
        </div>
      {/if}
    </div>
    {#if view === "matrix"}
      <section class="matrix-pane">
        {@render secretsWarning()}
        <div class="vars">
          <EnvironmentMatrix bind:this={matrix} {set} {inherited} {filter} {rowActions} {environmentActions} onaddenvironment={addEnv} />
        </div>
      </section>
    {:else}
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

          {@render secretsWarning()}

          <div class="vars">
            <KeyValueGrid
              bind:this={grid}
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
    {/if}
  </div>

  {#snippet footer()}
    <span class="hint muted">
      Saved to <span class="mono">{filePrefix}http-client.env.json</span> (shared) and <span class="mono">{filePrefix}http-client.private.env.json</span> (secrets)
    </span>
    <div class="spacer"></div>
    <button class="btn" onclick={requestClose}>Cancel</button>
    <button class="btn primary" disabled={saving || !dirty} onclick={save}>{saving ? "Saving…" : "Save"}</button>
  {/snippet}
</Modal>

<style>
  .frame {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .view-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  .view-bar :global(.env-folder) {
    min-width: 150px;
    max-width: 240px;
  }
  .matrix-pane {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .layout {
    display: flex;
    flex: 1;
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
