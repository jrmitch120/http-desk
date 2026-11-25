// The Response position choices (GLOSSARY "Response position"): their names in Settings,
// the View menu and the response pane's toggle, kept in one place.
import type { SegmentedOption } from "../components/SegmentedControl.svelte";
import type { ResponsePosition } from "./types";

/** In the order Settings lists them. `label` is sentence case, `menuLabel` the menu's title case. */
export const RESPONSE_POSITIONS: readonly (SegmentedOption<ResponsePosition> & { menuLabel: string })[] = [
  { value: "horizontal", label: "Response on the right", menuLabel: "Response on the Right", icon: "columns" },
  { value: "vertical", label: "Response below", menuLabel: "Response Below", icon: "rows" },
];

/** The choice for `position`. */
export function responsePosition(position: ResponsePosition) {
  return RESPONSE_POSITIONS.find((p) => p.value === position)!;
}
