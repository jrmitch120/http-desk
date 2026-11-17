<!--
  Settings → History: the History switch, retention's limits, where History is kept
  on disk, and Clear all history. A section of SettingsModal, styled by it; more History settings go
  here as further `.setting` rows. "History is off" (HistoryOff) links here.
-->
<script lang="ts">
  import { api } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import { HISTORY_BODY_CAP_TEXT } from "../lib/history.svelte";
  import NumberField from "./NumberField.svelte";
  import Toggle from "./Toggle.svelte";

  const retention = $derived(app.history.retention);

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
      <span>Entries per request</span>
      <small class="muted">The most each request keeps, newest first</small>
    </div>
    <NumberField label="Entries per request" integer min={1} value={retention.maxPerRequest} onchange={(v) => app.history.setRetention({ maxPerRequest: v })} />
  </div>
  <div class="setting">
    <div class="label">
      <span>Keep for</span>
      <small class="muted">Older entries are deleted</small>
    </div>
    <NumberField label="Keep for" unit="days" integer min={1} value={retention.maxAgeDays} onchange={(v) => app.history.setRetention({ maxAgeDays: v })} />
  </div>
  <div class="setting">
    <div class="label">
      <span>Total size</span>
      <small class="muted">For every workspace together; the oldest entries go first</small>
    </div>
    <NumberField label="Total size" unit="MB" integer min={1} value={retention.maxSizeMb} onchange={(v) => app.history.setRetention({ maxSizeMb: v })} />
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
  <p class="note muted">History stays on this computer, never in a workspace. Requests marked <span class="mono"># @no-log</span> are never recorded. Bodies over {HISTORY_BODY_CAP_TEXT} are cut off; a binary one keeps only its headers and size.</p>
</section>
