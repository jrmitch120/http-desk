<!--
  Settings → History: the History switch, where History is kept on disk, and Clear
  all history. A section of SettingsModal, styled by it; more History settings go
  here as further `.setting` rows. "History is off" (HistoryOff) links here.
-->
<script lang="ts">
  import { api } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import Toggle from "./Toggle.svelte";

  let location = $state<string | null>(null);
  api
    .historyLocation()
    .then((l) => (location = l))
    .catch(() => {});

  // Opened from "History is off": start at this section.
  let section: HTMLElement | undefined = $state();
  $effect(() => {
    if (app.settingsSection === "history" && section) {
      section.scrollIntoView({ block: "start" });
      app.settingsSection = null;
    }
  });
</script>

<section aria-labelledby="settings-history" bind:this={section}>
  <h3 id="settings-history">History</h3>
  <div class="setting">
    <div class="label">
      <span>Record History</span>
      <small class="muted">Keep each request you send from a tab, with its response</small>
    </div>
    <Toggle ariaLabel="Record History" checked={app.history.enabled} onchange={(v) => app.history.setEnabled(v)} />
  </div>
  <div class="setting">
    <div class="label">
      <span>Location</span>
      <small class="mono selectable" data-testid="history-location">{location ?? "Not available"}</small>
    </div>
  </div>
  <div class="setting">
    <div class="label">
      <span>Clear all history</span>
      <small class="muted">Deletes the History of every workspace</small>
    </div>
    <button class="btn small" onclick={() => app.history.clearAll()}>Clear all history</button>
  </div>
  <p class="note muted">History stays on this computer, never in a workspace. Requests marked <span class="mono"># @no-log</span> are never recorded.</p>
</section>
