// The theme choices, for the Settings switch.
import type { SegmentedOption } from "../components/SegmentedControl.svelte";
import type { AppSettings } from "./types";

export type ThemeChoice = AppSettings["theme"];

/** In the order Settings lists them. */
export const THEMES: readonly SegmentedOption<ThemeChoice>[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];
