<!--
  The Session panel's Global variables section: each value a script stored with
  `client.global.set`, which later requests in the workspace use as `{{name}}`, with
  a Delete button, and Clear Global variables. Read again whenever the Session
  changes, so a value a send's script sets shows up at once. No editing by hand.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { sessionView } from "../lib/sessionView.svelte";
  import type { GlobalVariable } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import SessionSection from "./SessionSection.svelte";

  const globals = sessionView<GlobalVariable[]>(() => app.globalVariables(), []);
  const list = $derived(globals.current ?? []);
</script>

<SessionSection title="Global variables" count={globals.current?.length ?? null} clearLabel="Clear Global variables" onclear={() => app.clearGlobals()}>
  {#if list.length}
    <div class="data-table">
      <table aria-label="Global variables">
        <thead>
          <tr><th>Name</th><th>Value</th><th></th></tr>
        </thead>
        <tbody>
          {#each list as g (g.name)}
            <tr>
              <td class="name">{g.name}</td>
              <td class="value">{g.value}</td>
              <td class="actions">
                <button class="icon-btn" aria-label="Delete Global variable {g.name}" use:tooltip onclick={() => app.deleteGlobal(g.name)}>
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if globals.current}
    <div class="none muted">
      No Global variables. A script's <code>client.global.set("name", value)</code> keeps a value here, for <code>{"{{name}}"}</code> in any request of the workspace.
    </div>
  {/if}
</SessionSection>

<style>
  .none {
    padding: 6px 16px 10px;
    font-size: 12px;
  }
  .none code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .name {
    font-weight: 600;
    white-space: nowrap;
    color: var(--text-2);
  }
  .value {
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .actions {
    white-space: nowrap;
    text-align: right;
    width: 1%;
  }
</style>
