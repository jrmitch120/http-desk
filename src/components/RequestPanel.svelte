<!--
  The response viewer's Request tab: the request that reached the server that
  sent the final response, as the core reconstructs it (after redirects, the
  last hop's URL, method, body and headers), with the send's timing. The
  Authorization value is masked.
-->
<script lang="ts">
  import { formatBytes, formatDuration } from "../lib/http";
  import { formatPhase, redirectNote, timingPhases } from "../lib/timing";
  import type { HttpResponse } from "../lib/types";

  let { res }: { res: HttpResponse } = $props();

  /** Keeps the scheme ("Bearer") and hides the credential. */
  const shown = (name: string, value: string) => (name.toLowerCase() === "authorization" ? value.replace(/^(\S+\s+).+$/, "$1••••••••") : value);
</script>

<div class="data-table">
  <div class="sent-line selectable mono"><strong>{res.request.method}</strong> {res.request.url}</div>
  <table>
    <tbody>
      {#each res.request.headers as [k, v], i (i)}
        <tr><td class="k">{k}</td><td class="v selectable">{shown(k, v)}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if res.request.bodyPreview !== null}
    <div class="sent-body-title muted">Body · {formatBytes(res.request.bodySize)}</div>
    <pre class="sent-body selectable mono">{res.request.bodyPreview}</pre>
  {/if}
  <div class="sent-body-title muted">Timing · {formatDuration(res.timeMs)} total{res.timings.redirects ? `, ${redirectNote(res.timings.redirects)}` : ""}</div>
  <div class="sent-timing selectable mono">
    {timingPhases(res).map((p) => `${p.label} ${formatPhase(p.ms)}`).join(" · ")}{res.timings.reused ? " · reused connection" : ""}
  </div>
  <p class="muted small">
    A reconstruction of the final request from what HttpDesk prepared, not the bytes on the wire. Disabled components and unresolved sections are not included.
    {#if res.timings.redirects}After redirects it shows the last hop: its URL, its method and body after 301, 302 or 303, and without credentials a cross-origin hop drops.{/if}
  </p>
</div>

<style>
  .small {
    font-size: 12px;
  }
  .sent-line {
    padding: 8px;
    font-size: 12.5px;
    word-break: break-all;
  }
  .sent-body-title {
    margin: 14px 8px 6px;
    font-size: 12px;
  }
  .sent-timing {
    padding: 0 8px;
    font-size: 12px;
  }
  .sent-body {
    margin: 0;
    padding: 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 320px;
    overflow: auto;
  }
</style>
