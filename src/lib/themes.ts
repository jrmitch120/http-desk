// The theme choices, shared by the Settings switch and the top bar's theme menu.
import type { AppSettings } from "./types";

export type ThemeChoice = AppSettings["theme"];

/** In the order both list them. */
export const THEMES: readonly { value: ThemeChoice; label: string; icon: string }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function themeLabel(theme: ThemeChoice): string {
  return THEMES.find((t) => t.value === theme)?.label ?? theme;
}
