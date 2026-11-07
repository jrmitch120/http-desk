<!--
  The response viewer's Cookies tab: every cookie the response set, redirect
  hops included, one column per attribute, with click-to-copy values. A
  Set-Cookie that didn't parse is listed raw with the reason. Display only:
  nothing here is sent back on later requests. With no cookies it says so.
-->
<script lang="ts">
  import { cookieExpiry } from "../lib/cookies";
  import { copyable } from "../lib/copyable";
  import type { ResponseCookie } from "../lib/types";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";

  /** `url` is the final URL; a cookie set by any other URL came from a redirect hop. */
  let { cookies, url }: { cookies: ResponseCookie[]; url: string } = $props();

  const COLUMNS = ["Name", "Value", "Domain", "Path", "Expires", "Secure", "HttpOnly", "SameSite", "Set by"];

  function host(u: string): string {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }

</script>

{#if cookies.length === 0}
  <div class="empty-state small">This response set no cookies.</div>
{:else}
<div class="data-table">
  <table aria-label="Response cookies">
    <thead>
      <tr>{#each COLUMNS as c (c)}<th>{c}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each cookies as c, i (i)}
        <tr>
          {#if c.parseError !== null}
            <td class="unparsed" colspan={COLUMNS.length - 1}>
              <div class="mono selectable">{c.raw}</div>
              <div class="muted">Could not parse: {c.parseError}</div>
            </td>
          {:else}
            <td class="name"><span use:tooltip={`Set-Cookie: ${c.raw}`}>{c.name}</span></td>
            <td class="v">
              {#if c.value}
                <button class="copyable" use:tooltip={"Click to copy"} use:copyable={{ value: c.value, copied: "Cookie value copied" }}>{c.value}</button>
              {:else}
                <span class="muted">(empty)</span>
              {/if}
            </td>
            <td class="mono">
              {#if c.domain !== null}{c.domain}{:else}<span class="muted" use:tooltip={"No Domain attribute: sent back only to this host"}>{host(c.url)}</span>{/if}
            </td>
            <td class="mono">{c.path ?? ""}</td>
            <td class="nowrap">{cookieExpiry(c)}</td>
            <td>{c.secure ? "Yes" : ""}</td>
            <td>{c.httpOnly ? "Yes" : ""}</td>
            <td>{c.sameSite ?? ""}</td>
          {/if}
          <td class="mono set-by">
            <span class="selectable">{c.url}</span>
            {#if c.url !== url}<span class="tip" use:tooltip={"Set by a redirect before the final response"}><Badge>Redirect</Badge></span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
{/if}

<style>
  .small {
    font-size: 12px;
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
  .v {
    min-width: 120px;
  }
  .nowrap {
    white-space: nowrap;
  }
  .set-by {
    word-break: break-all;
  }
  .tip {
    display: inline-flex;
    margin-left: 6px;
    vertical-align: middle;
  }
  .unparsed .muted {
    margin-top: 2px;
    font-size: 12px;
  }
</style>
