<script lang="ts">
  // A small pill: HTTP methods, response statuses, "OFF", "Active", versions.
  // Every badge shares one type, corner radius and padding per size; only the
  // colour changes. `method` and `status` pick their colour from the method or
  // status; otherwise `tone` does. Method badges are as wide as six letters, and
  // show at most six, so they line up in lists. To adjust one at a call site,
  // pass a `class` and style it with `:global(...)`.
  import type { Snippet } from "svelte";
  import { methodClass, statusClass } from "../lib/http";

  interface Props {
    /** An HTTP method; its first six letters are the text unless `children` is given. */
    method?: string;
    /** An HTTP status code (colour only; pass the text as `children`). */
    status?: number;
    tone?: "neutral" | "success" | "warning" | "danger" | "info";
    size?: "sm" | "md";
    class?: string;
    children?: Snippet;
  }
  let { method, status, tone = "neutral", size = "sm", class: className = "", children }: Props = $props();

  const colour = $derived(method !== undefined ? methodClass(method) : status !== undefined ? statusClass(status) : tone);
</script>

<span class="badge {size} {colour} {className}" class:method={method !== undefined}>
  {#if children}{@render children()}{:else}{method?.slice(0, 6)}{/if}
</span>

<style>
  .badge {
    --pad: var(--space-1);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    box-sizing: border-box;
    height: var(--space-4);
    padding: 0 var(--pad);
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
    background: color-mix(in srgb, currentColor 14%, transparent);
  }
  .md {
    --pad: var(--space-2);
    height: var(--space-5);
    font-size: 11.5px;
  }
  .method {
    min-width: calc(6ch + 2 * var(--pad));
  }
  .neutral {
    color: var(--muted);
    background: var(--panel-3);
  }
  .success {
    color: var(--success);
  }
  .warning {
    color: var(--warning);
  }
  .danger {
    color: var(--danger);
  }
  .info {
    color: var(--info);
  }
</style>
