// The colours an environment can be given (Environments modal) to tint the top
// bar's environment indicator. A fixed palette rather than any colour, so each
// one has a shade per theme that stands out from the bar (envColors.test.ts).

export const ENV_COLORS = [
  { value: "red", label: "Red", dark: "#f2706b", light: "#c8352b" },
  { value: "orange", label: "Orange", dark: "#f59e5b", light: "#b35309" },
  { value: "yellow", label: "Yellow", dark: "#e8c34c", light: "#8a6a00" },
  { value: "green", label: "Green", dark: "#4fc08d", light: "#108a4c" },
  { value: "blue", label: "Blue", dark: "#5b9dff", light: "#1f6fd1" },
  { value: "purple", label: "Purple", dark: "#c3a6ff", light: "#7b4fc4" },
] as const;

export type EnvColor = (typeof ENV_COLORS)[number]["value"];

/** The colour if it's one of the palette's (a hand-edited settings file may hold anything). */
export function envColor(name: string | null | undefined): EnvColor | null {
  return ENV_COLORS.some((c) => c.value === name) ? (name as EnvColor) : null;
}

/** The CSS colour of a palette entry in a theme. */
export function envColorShade(color: EnvColor, theme: "light" | "dark"): string {
  return ENV_COLORS.find((c) => c.value === color)![theme];
}
