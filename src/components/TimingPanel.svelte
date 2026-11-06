<!-- The response viewer's Timing tab: a waterfall of the final request's phases
     (see src/lib/timing.ts), whether its connection was reused, and the total
     across every hop. -->
<script lang="ts">
  import type { HttpResponse } from "../lib/types";
  import { formatDuration } from "../lib/http";
  import { formatPhase, redirectNote, timingPhases } from "../lib/timing";
  import Badge from "./Badge.svelte";

  let { res }: { res: HttpResponse } = $props();

  const phases = $derived(timingPhases(res));
  const scale = $derived(Math.max(res.timeMs, ...phases.map((p) => p.start + p.ms), 0.001));
  const pct = (ms: number) => `${(ms / scale) * 100}%`;
</script>

<div class="timing">
  <div class="summary">
    <span class="total"><span class="muted">Total</span> <span class="mono">{formatDuration(res.timeMs)}</span></span>
    {#if res.timings.redirects}
      <span class="muted">{redirectNote(res.timings.redirects)}; the phases are the final request's</span>
    {/if}
    <span class="spacer"></span>
    <Badge>{res.timings.reused ? "Reused connection" : "New connection"}</Badge>
  </div>
  <div class="waterfall" role="list" aria-label="Timing phases">
    {#each phases as p (p.key)}
      <div class="row" role="listitem">
        <span class="label">{p.label}</span>
        <span class="track"><span class="bar {p.key}" style:left={pct(p.start)} style:width={pct(p.ms)}></span></span>
        <span class="ms mono">{formatPhase(p.ms)}</span>
      </div>
    {/each}
  </div>
  {#if res.timings.reused}
    <p class="muted note">No DNS lookup or connect: the request went over a connection that was already open.</p>
  {/if}
</div>

<style>
  .timing {
    flex: 1;
    overflow: auto;
    padding: var(--space-3) var(--space-4) var(--space-4);
    font-size: 12.5px;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  .spacer {
    flex: 1;
  }
  .total .mono {
    font-weight: 600;
  }
  .waterfall {
    display: grid;
    grid-template-columns: max-content 1fr max-content;
    column-gap: var(--space-4);
  }
  .row {
    display: contents;
  }
  .row > * {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }
  .label {
    color: var(--text-2);
    font-weight: 600;
  }
  .track {
    position: relative;
  }
  .bar {
    position: absolute;
    top: 50%;
    height: var(--space-3);
    min-width: 2px;
    transform: translateY(-50%);
    border-radius: var(--radius-sm);
  }
  .bar.dns {
    background: var(--info);
  }
  .bar.connect {
    background: var(--warning);
  }
  .bar.ttfb {
    background: var(--accent);
  }
  .bar.download {
    background: var(--success);
  }
  .ms {
    text-align: right;
    font-size: 12px;
  }
  .note {
    margin: var(--space-3) 0 0;
    font-size: 12px;
  }
</style>
