// Guardrail for ADR 0002's focus marks: the app decides when keyboard focus is
// drawn (src/lib/focusMarks.ts), so no control styles or tests for the webview's
// :focus-visible, which macOS's webview doesn't match after a click. Style focus
// with `:root[data-focus-marks] .x:focus` instead (text fields: plain `:focus`).
import { expect, it } from "vitest";

// Every app source and stylesheet except tests and this guardrail.
const sources = import.meta.glob(["/src/**/*.svelte", "/src/**/*.ts", "/src/**/*.css", "!/src/**/*.test.ts", "!/src/guardrail/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The source with its comments blanked, keeping line numbers. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/.*$/gm, (c) => c.replace(/[^\n]/g, " "));

it("no control draws focus from the webview's :focus-visible", () => {
  expect(sources["/src/app.css"]).toContain(".btn");
  const uses = Object.entries(sources).flatMap(([path, source]) =>
    code(source)
      .split("\n")
      .flatMap((text, i) => (text.includes(":focus-visible") ? [`${path.slice(1)}:${i + 1}`] : [])),
  );
  expect(uses, `Style focus from the focus marks instead (src/lib/focusMarks.ts):\n${uses.join("\n")}\n`).toEqual([]);
});
