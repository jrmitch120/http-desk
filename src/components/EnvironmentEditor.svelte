<script lang="ts">
  // Graphical editor for http-client.env.json / http-client.private.env.json.
  import { api, errorMessage } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import type { EnvironmentSet, EnvVar } from "../lib/types";
  import Icon from "./Icon.svelte";
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
  let revealed = $state<Record<string, boolean>>({});
  let saving = $state(false);

  const vars = $derived(selected === SHARED ? set.shared : (set.environments.find((e) => e.name === selected)?.variables ?? set.shared));
  const dirty = $derived(JSON.stringify(clean($state.snapshot(set) as EnvironmentSet)) !== savedJson || activeEnv !== app.envName);
  const hasSecrets = $derived(set.shared.some((v) => v.secret) || set.environments.some((e) => e.variables.some((v) => v.secret)));

  // Keep a trailing blank row so typing into it creates a new variable.
  $effect(() => {
    const list = vars;
    const last = list[list.length - 1];
    if (!last || last.name !== "" || last.value !== "") list.push({ name: "", value: "", secret: false });
  });

  const rows = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return vars
      .map((v, i) => ({ v, i }))
      .filter(({ v, i }) => i === vars.length - 1 || !q || v.name.toLowerCase().includes(q) || (!v.secret && v.value.toLowerCase().includes(q)));
  });

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
    if (selected === name) selected = next;
    if (activeEnv === name) activeEnv = next;
  }

  function duplicateEnv(name: string) {
    const env = set.environments.find((e) => e.name === name);
    if (!env) return;
    let copy = `${name} copy`;
    for (let n = 2; nameTaken(copy); n++) copy = `${name} copy ${n}`;
    set.environments.splice(set.environments.indexOf(env) + 1, 0, { name: copy, variables: structuredClone($state.snapshot(env.variables) as EnvVar[]) });
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
      app.toast("success", "Environments saved");
      if (report.gitignoreUpdated) app.toast("info", "Added http-client.private.env.json to .gitignore");
      await app.loadEnvironments();
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

<Modal title="Environments" width="860px" height="560px" onclose={requestClose}>
  <div class="layout">
    <aside>
      <div class="side-head">
        <span class="muted">Environments</span>
        <button class="icon-btn" title="New environment" onclick={addEnv}><Icon name="plus" /></button>
      </div>
      <div class="list">
        <button class="env" class:selected={selected === SHARED} onclick={() => (selected = SHARED)}>
          <Icon name="globe" size={14} />
          <span class="ellipsis grow">Shared variables</span>
          <span class="count">{countOf(set.shared)}</span>
        </button>
        <div class="divider"></div>
        {#each set.environments as env (env.name)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="env" class:selected={selected === env.name} onclick={() => (selected = env.name)} ondblclick={() => renameEnv(env.name)} role="button" tabindex="0">
            <Icon name="layers" size={14} />
            <span class="ellipsis grow">{env.name}</span>
            {#if activeEnv === env.name}<span class="active-pill">Active</span>{/if}
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
            title={onDisk(selected) ? "Select this environment for sending requests" : "Save environments and select this one for sending requests"}
          >
            <Icon name="check" size={13} />{inUse ? "In use" : onDisk(selected) ? "Use" : "Save & use"}
          </button>
          <button class="icon-btn" title="Rename" onclick={() => renameEnv(selected)}><Icon name="edit" size={14} /></button>
          <button class="icon-btn" title="Duplicate" onclick={() => duplicateEnv(selected)}><Icon name="copy" size={14} /></button>
          <button class="icon-btn danger-hover" title="Delete" onclick={() => deleteEnv(selected)}><Icon name="trash" size={14} /></button>
        {/if}
        <div class="filter">
          <Icon name="search" size={13} />
          <input class="input" placeholder="Filter variables" bind:value={filter} />
        </div>
      </div>

      {#if hasSecrets && set.privateFileIgnored === false}
        <div class="banner warning">
          <Icon name="alert" />
          <span><span class="mono">http-client.private.env.json</span> is not ignored by git. Secrets could be committed — add it to <span class="mono">.gitignore</span>.</span>
        </div>
      {/if}

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="c-name">Variable</th>
              <th>Value</th>
              <th class="c-act"></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as { v, i } (i)}
              {@const blank = i === vars.length - 1}
              {@const key = `${selected}:${i}`}
              <tr class:blank>
                <td class="c-name">
                  <input class="cell mono" placeholder={blank ? "Add variable" : ""} bind:value={v.name} spellcheck="false" />
                </td>
                <td>
                  <div class="value-cell">
                    <input
                      class="cell mono"
                      type={v.secret && !revealed[key] ? "password" : "text"}
                      placeholder={blank ? "Value" : ""}
                      bind:value={v.value}
                      spellcheck="false"
                    />
                    {#if v.secret}
                      <button class="icon-btn" title={revealed[key] ? "Hide value" : "Show value"} onclick={() => (revealed[key] = !revealed[key])}>
                        <Icon name={revealed[key] ? "eye-off" : "eye"} size={13} />
                      </button>
                    {/if}
                  </div>
                </td>
                <td class="c-act">
                  {#if !blank}
                    <button
                      class="icon-btn"
                      class:active={v.secret}
                      title={v.secret ? "Secret: stored in http-client.private.env.json — click to make shareable" : "Secret: stored in http-client.private.env.json — click to mark as secret"}
                      onclick={() => (v.secret = !v.secret)}
                    >
                      <Icon name={v.secret ? "lock" : "unlock"} size={13} />
                    </button>
                    <button class="icon-btn danger-hover" title="Delete variable" onclick={() => vars.splice(i, 1)}><Icon name="trash" size={13} /></button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
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
  .grow {
    flex: 1;
    min-width: 0;
  }
  .count {
    font-size: 11px;
    color: var(--faint);
  }
  .active-pill {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--success) 18%, transparent);
    color: var(--success);
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
  .table-wrap {
    flex: 1;
    overflow: auto;
    padding: 4px 14px 14px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  th {
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: var(--muted);
    padding: 8px 8px 6px;
    border-bottom: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  td {
    border-bottom: 1px solid var(--border);
    padding: 0;
  }
  .c-name {
    width: 34%;
    border-right: 1px solid var(--border);
  }
  .c-act {
    width: 64px;
    text-align: right;
    white-space: nowrap;
    padding-right: 2px;
  }
  .value-cell {
    display: flex;
    align-items: center;
    padding-right: 4px;
  }
  .cell {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    background: transparent;
    border: 1px solid transparent;
    outline: none;
    font-size: 12.5px;
    border-radius: 3px;
  }
  .cell:hover {
    background: var(--panel-2);
  }
  .cell:focus {
    border-color: var(--focus);
    background: var(--panel-2);
  }
  .cell::placeholder {
    color: var(--faint);
  }
  tr.blank .cell::placeholder {
    font-style: italic;
  }
  .hint {
    font-size: 11.5px;
  }
</style>
