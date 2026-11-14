<!--
  The Session panel's Named exchanges section: each `# @name` request with a latest
  exchange in the Session, which its file's Request variables read, with its file,
  status and when it arrived. One opens in the response viewer (ExchangeView) or is
  forgotten; Clear forgets them all, so every Request variable reads as unsent. Read
  again whenever the Session changes, so a send shows up at once.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { receivedAt, workspaceFile } from "../lib/exchanges";
  import { sessionView } from "../lib/sessionView.svelte";
  import type { NamedExchange } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";
  import SessionSection from "./SessionSection.svelte";

  const exchanges = sessionView<NamedExchange[]>(() => app.namedExchanges(), []);
  const list = $derived(exchanges.current ?? []);
</script>

<SessionSection title="Named exchanges" count={exchanges.current?.length ?? null} clearLabel="Clear named exchanges" onclear={() => app.clearNamedExchanges()}>
  {#if list.length}
    <div class="data-table">
      <table aria-label="Named exchanges">
        <thead>
          <tr><th>Name</th><th>File</th><th>Status</th><th>Received</th><th></th></tr>
        </thead>
        <tbody>
          {#each list as e (`${e.file}\0${e.name}`)}
            <tr>
              <td class="name">{e.name}</td>
              <td class="mono">{workspaceFile(app.root, e.file)}</td>
              <td><Badge status={e.status}>{e.status}</Badge></td>
              <td class="nowrap">{receivedAt(e.received)}</td>
              <td class="actions">
                <button class="icon-btn" aria-label="Open {e.name}" use:tooltip={"Show this exchange's response"} onclick={() => app.openExchange(e)}>
                  <Icon name="reveal" size={13} />
                </button>
                <button class="icon-btn" aria-label="Forget {e.name}" use:tooltip={"Forget this exchange: its Request variables read as not sent"} onclick={() => app.removeNamedExchange(e)}>
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if exchanges.current}
    <div class="none muted">
      No named exchanges. Sending a request with <code># @name</code> keeps its latest exchange here, for <code>{"{{name.response…}}"}</code> in its file to read.
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
  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .nowrap {
    white-space: nowrap;
  }
  .actions {
    white-space: nowrap;
    text-align: right;
    width: 1%;
  }
</style>
