<!--
  The response viewer's Cookies tab: every cookie the response set, redirect
  hops included, one column per attribute, with click-to-copy values. A
  Set-Cookie that didn't parse is listed raw with the reason. The Session's
  cookie jar keeps the others and sends them on later requests (the Session
  panel lists the jar). With no cookies it says so.
-->
<script lang="ts">
  import { responseCookieRow } from "../lib/cookies";
  import type { ResponseCookie } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";
  import CookieTable from "./CookieTable.svelte";

  /** `url` is the final URL; a cookie set by any other URL came from a redirect hop. */
  let { cookies, url }: { cookies: ResponseCookie[]; url: string } = $props();

  const rows = $derived(cookies.map(responseCookieRow));
</script>

{#snippet setBy(i: number)}
  {@const c = cookies[i]}
  <span class="set-by">
    <span class="selectable">{c.url}</span>
    {#if c.url !== url}<span class="tip" use:tooltip={"Set by a redirect before the final response"}><Badge>Redirect</Badge></span>{/if}
  </span>
{/snippet}

{#if cookies.length === 0}
  <div class="empty-state small">This response set no cookies.</div>
{:else}
  <CookieTable {rows} label="Response cookies" extra={{ heading: "Set by", cell: setBy }} />
{/if}

<style>
  .small {
    font-size: 12px;
  }
  .set-by {
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .tip {
    display: inline-flex;
    margin-left: 6px;
    vertical-align: middle;
  }
</style>
