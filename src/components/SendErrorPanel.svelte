<script lang="ts">
  // Why the last send failed: a heading and hint chosen by the error's kind,
  // the core's message, and the buttons that act on it. Retry is always there;
  // kind-specific fix-it buttons go before it.
  import { describeSendError } from "../lib/sendError";
  import type { SendError } from "../lib/types";
  import Banner from "./Banner.svelte";

  let { error, onretry }: { error: SendError; onretry: () => void } = $props();

  const text = $derived(describeSendError(error));
</script>

<Banner severity="error" inline heading={text.heading} class="send-error">
  <div class="err-msg selectable mono">{error.message}</div>
  {#if text.hint}<div class="muted">{text.hint}</div>{/if}
  {#snippet actions()}
    <!-- Fix-it buttons by kind (TLS settings, request settings, environment) go here. -->
    <button class="btn small" onclick={onretry}>Retry</button>
  {/snippet}
</Banner>

<style>
  .err-msg {
    color: var(--text);
    margin: 4px 0 6px;
    word-break: break-word;
  }
</style>
