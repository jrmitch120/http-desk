<!--
  A table of cookies, one column per attribute, with click-to-copy values: the
  look the response viewer's Cookies tab and the Session panel's Cookies section
  share. A row that didn't parse shows its raw Set-Cookie and the reason. The
  caller adds a last column (the hop that set it, a Delete button) with `extra`.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { CookieRow } from "../lib/cookies";
  import { copyable } from "../lib/copyable";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  interface Props {
    rows: CookieRow[];
    /** The table's accessible name. */
    label: string;
    /** The last column's heading and cell, if any. */
    extra?: { heading: string; cell: Snippet<[number]> };
  }

  let { rows, label, extra }: Props = $props();

  const ATTRIBUTES = ["Name", "Value", "Domain", "Path", "Expires", "Secure", "HttpOnly", "SameSite"];
</script>

<div class="data-table">
  <table aria-label={label}>
    <thead>
      <tr>
        {#each ATTRIBUTES as c (c)}<th>{c}</th>{/each}
        {#if extra}<th>{extra.heading}</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as c, i (i)}
        <tr>
          {#if c.parseError}
            <td class="unparsed" colspan={ATTRIBUTES.length}>
              <div class="mono selectable">{c.raw}</div>
              <div class="muted">Could not parse: {c.parseError}</div>
            </td>
          {:else}
            <td class="name">
              {#if c.raw}<span use:tooltip={`Set-Cookie: ${c.raw}`}>{c.name}</span>{:else}{c.name}{/if}
            </td>
            <td class="v">
              {#if c.value}
                <button class="copyable" use:tooltip={"Click to copy"} use:copyable={{ value: c.value, copied: "Cookie value copied" }}>{c.value}</button>
              {:else}
                <span class="muted">(empty)</span>
              {/if}
            </td>
            <td class="mono">
              {#if c.hostOnly}<span class="muted" use:tooltip={"No Domain attribute: sent back only to this host"}>{c.domain}</span>{:else}{c.domain}{/if}
            </td>
            <td class="mono">{c.path}</td>
            <td class="nowrap">{c.expiry}</td>
            <td>{c.secure ? "Yes" : ""}</td>
            <td>{c.httpOnly ? "Yes" : ""}</td>
            <td>{c.sameSite ?? ""}</td>
          {/if}
          {#if extra}<td class="extra">{@render extra.cell(i)}</td>{/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
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
  .unparsed .muted {
    margin-top: 2px;
    font-size: 12px;
  }
</style>
