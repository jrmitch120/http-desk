// A section of the Settings modal that `app.openSettings(section)` can open it at:
//
//   <section aria-labelledby="settings-tls" use:settingsSection={"tls"}>…</section>
//
// When Settings opens at that section, it's scrolled into view and the request is
// cleared. One mechanism for every section; a new one only adds its name to
// `SettingsSection` (store.svelte.ts) and this action to its `<section>`.

import { app, type SettingsSection } from "./store.svelte";

export function settingsSection(node: HTMLElement, section: SettingsSection) {
  $effect(() => {
    if (app.settingsSection !== section) return;
    node.scrollIntoView({ block: "start" });
    app.settingsSection = null;
  });
}
