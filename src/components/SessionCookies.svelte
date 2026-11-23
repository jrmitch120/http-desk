<!--
  The Session panel's Cookies section: every cookie in the Session's jar, in the
  Cookies tab's look, each with a Delete button, and Clear cookies. Read again
  whenever the Session changes, so cookies a send sets show up at once. No
  editing or adding cookies by hand. Its rows are the last of the panel's list
  (sessionRow): Enter copies a cookie's value, Delete deletes it.
-->
<script lang="ts">
  import { api } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import { storedCookieRow } from "../lib/cookies";
  import { sessionView } from "../lib/sessionView.svelte";
  import type { StoredCookie } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import CookieTable from "./CookieTable.svelte";
  import Icon from "./Icon.svelte";
  import SessionSection from "./SessionSection.svelte";
  import { sessionRow } from "../lib/sessionList";

  const cookies = sessionView<StoredCookie[]>(() => api.sessionCookies(), []);
  const list = $derived(cookies.current ?? []);
  const row = (i: number) =>
    sessionRow({
      copy: { value: list[i].value, copied: "Cookie value copied" },
      remove: { label: "Delete", run: () => app.deleteCookie(list[i]) },
    });
</script>

{#snippet remove(i: number)}
  <button class="icon-btn" tabindex="-1" aria-label="Delete cookie {list[i].name}" use:tooltip onclick={() => app.deleteCookie(list[i])}>
    <Icon name="trash" size={13} />
  </button>
{/snippet}

<SessionSection title="Cookies" count={cookies.current?.length ?? null} clearLabel="Clear cookies" onclear={() => app.clearCookies()}>
  {#if list.length}
    <CookieTable rows={list.map(storedCookieRow)} label="Session cookies" extra={{ heading: "", cell: remove }} list={row} />
  {:else if cookies.current}
    <div class="none muted">No cookies. Cookies that responses set are kept here and sent on later requests to the same site.</div>
  {/if}
</SessionSection>

<style>
  .none {
    padding: 6px 16px 10px;
    font-size: 12px;
  }
</style>
