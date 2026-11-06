// Files that still contain a native widget, per widget kind (ADR 0002, #36).
//
// This list only shrinks. When a ticket converts a screen to the owned
// controls, delete that file's line from each kind it no longer uses; the
// guardrail fails if an entry is left behind for a file that's been converted.
// Never add a line: use the owned control instead. The list is empty when #36
// is done.
import type { Allowlist } from "./native-widgets";

export const ALLOWLIST: Allowlist = {
  select: [
    "src/components/AuthEditor.svelte",
    "src/components/BodyEditor.svelte",
    "src/components/RequestEditor.svelte",
    "src/components/TopBar.svelte",
  ],
  checkbox: [
    "src/components/BodyEditor.svelte",
    "src/components/KeyValueTable.svelte",
    "src/components/OpenApiImport.svelte",
  ],
  radio: [
    "src/components/BodyEditor.svelte",
  ],
  number: [
    "src/components/SettingsModal.svelte",
  ],
  datalist: [
    "src/components/KeyValueTable.svelte",
  ],
  title: [],
};
