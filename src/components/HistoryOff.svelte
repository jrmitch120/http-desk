<!--
  What a History view shows while the History switch is off: "History is off", with
  a link to the setting (Settings → History). Shared by the History views.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
</script>

<div class="empty-state off">
  <span>History is off</span>
  <button class="link" onclick={() => app.openSettings("history")}>Turn it on in Settings</button>
</div>

<style>
  .off {
    font-size: 12px;
  }
</style>
