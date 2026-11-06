// The theme choices, shared by the Settings switch and the top bar's theme menu.
import type { SegmentedOption } from "../components/SegmentedControl.svelte";
import type { AppSettings } from "./types";

export type ThemeChoice = AppSettings["theme"];

/** In the order both list them. */
export const THEMES: readonly SegmentedOption<ThemeChoice>[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function themeLabel(theme: ThemeChoice): string {
  return THEMES.find((t) => t.value === theme)?.label ?? theme;
}
