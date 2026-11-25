// The Response position choices (GLOSSARY "Response position"): their names in Settings,
// the View menu and the response pane's move button, kept in one place.
import type { SegmentedOption } from "../components/SegmentedControl.svelte";
import type { ResponsePosition } from "./types";

/**
 * In the order Settings lists them. `label` is sentence case, `menuLabel` the menu's title
 * case, `to` how the response pane's move button says it moves the response there.
 */
export const RESPONSE_POSITIONS: readonly (SegmentedOption<ResponsePosition> & { menuLabel: string; to: string })[] = [
  { value: "horizontal", label: "Response on the right", menuLabel: "Response on the Right", to: "to the right", icon: "columns" },
  { value: "vertical", label: "Response below", menuLabel: "Response Below", to: "below", icon: "rows" },
];

/** The choice for `position`. */
export function responsePosition(position: ResponsePosition) {
  return RESPONSE_POSITIONS.find((p) => p.value === position)!;
}

/** The position that isn't `position`: where moving the response takes it. */
export function otherResponsePosition(position: ResponsePosition): ResponsePosition {
  return position === "horizontal" ? "vertical" : "horizontal";
}
