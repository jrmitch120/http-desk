<script lang="ts">
  // About HttpDesk: which version this is, where its docs and release notes
  // are, and a Copy button for bug reports. HttpDesk's own modal, not the OS's
  // About panel (ADR-0002).
  import { app } from "../lib/store.svelte";
  import { errorMessage } from "../lib/api";
  import { appInfo, DOCUMENTATION_URL, openLink, RELEASE_NOTES_URL, versionLine } from "../lib/about";
  import type { AppInfo } from "../lib/types";
  import AppIcon from "./AppIcon.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  let info = $state<AppInfo | null>(null);
  appInfo()
    .then((i) => (info = i))
    .catch((e) => app.toast("error", errorMessage(e)));

  async function copy() {
    if (!info) return;
    await navigator.clipboard.writeText(versionLine(info));
    app.toast("success", "Version copied");
  }
</script>

<Modal title="About HttpDesk" width="360px" onclose={() => (app.modal = null)}>
  <div class="about">
    <AppIcon size={64} />
    <h3>HttpDesk</h3>
    <p class="version">{info ? `Version ${info.version}` : ""}</p>
    <p class="muted copyright">© 2026 Jeff Mitchell</p>
    <div class="links">
      <button class="link" onclick={() => openLink(DOCUMENTATION_URL)}>Documentation</button>
      <button class="link" onclick={() => openLink(RELEASE_NOTES_URL)}>Release Notes</button>
    </div>
  </div>
  {#snippet footer()}
    <button class="btn" disabled={!info} onclick={copy}><Icon name="copy" />Copy</button>
  {/snippet}
</Modal>

<style>
  .about {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-1);
    padding: var(--space-6) var(--space-4) var(--space-4);
  }
  h3 {
    margin: var(--space-2) 0 0;
    font-size: 18px;
    font-weight: 650;
  }
  p {
    margin: 0;
  }
  .version {
    font-variant-numeric: tabular-nums;
    min-height: 1lh;
  }
  .copyright {
    font-size: 12px;
  }
  .links {
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-3);
  }
</style>
