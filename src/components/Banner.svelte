<script lang="ts">
  // A warning, error or info message. Errors are announced as alerts; warnings
  // and info as a status, so screen readers say them without interrupting.
  // Default is a full-width strip under a toolbar; `inline` is a boxed banner
  // inside content (modals, panels). Spacing around an inline banner is the
  // caller's: pass a `class` and style it with `:global(...)`.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    severity: "warning" | "error" | "info";
    inline?: boolean;
    /** Bold first line above the message. */
    heading?: string;
    class?: string;
    children: Snippet;
    /** Buttons shown at the end of the banner. */
    actions?: Snippet;
  }
  let { severity, inline = false, heading, class: className = "", children, actions }: Props = $props();
</script>

<div class="banner {severity} {className}" class:inline role={severity === "error" ? "alert" : "status"}>
  <span class="icon"><Icon name={severity === "info" ? "info" : "alert"} /></span>
  <div class="message">
    {#if heading}<div class="heading">{heading}</div>{/if}
    {@render children()}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .banner {
    --tone: var(--warning);
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: 12px;
    line-height: 1.45;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 12%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .error {
    --tone: var(--danger);
  }
  .info {
    --tone: var(--info);
  }
  .inline {
    border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
    border-radius: var(--radius);
  }
  .icon {
    display: flex;
    align-items: center;
    flex: none;
    height: 1.45em;
  }
  .message {
    flex: 1;
    min-width: 0;
  }
  .heading {
    font-weight: 600;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
    align-self: center;
  }
</style>
