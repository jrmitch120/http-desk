// Environment colours tint the top bar's environment indicator (icon and
// border), so each needs a shade per theme that stands out from the bar.
import { describe, expect, it } from "vitest";
import { ENV_COLORS, envColor, envColorShade } from "./envColors";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --panel and --panel-2 in src/app.css: the top bar and the indicator's background.
describe.each([
  ["dark", ["#222327", "#292a2f"]],
  ["light", ["#ffffff", "#f7f7f8"]],
] as const)("in the %s theme", (theme, backgrounds) => {
  it.each(ENV_COLORS.map((c) => c.value))("%s stands out from the top bar (3:1, as for icons)", (color) => {
    for (const bg of backgrounds) expect(contrast(envColorShade(color, theme), bg)).toBeGreaterThanOrEqual(3);
  });
});

it("ignores colours outside the palette, as a hand-edited settings file may hold", () => {
  expect(envColor("blue")).toBe("blue");
  expect(envColor("#123456")).toBeNull();
  expect(envColor(undefined)).toBeNull();
});
