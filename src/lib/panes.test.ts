// The pane defaults live twice: SIDEBAR/SPLIT/PANEL here, and AppSettings::default()
// in the Rust shell, which a fresh install (or a reset) starts from.
import { describe, expect, it } from "vitest";
import shell from "../../src-tauri/src/lib.rs?raw";
import { PANEL, SIDEBAR, SPLIT } from "./panes";

/** The number `pattern` captures in the Rust source. */
function rustNumber(pattern: RegExp): number {
  const m = shell.match(pattern);
  if (!m) throw new Error(`src-tauri/src/lib.rs no longer matches ${pattern}; update this test`);
  return Number(m[1]);
}

describe("pane defaults", () => {
  it("match AppSettings::default() in src-tauri/src/lib.rs", () => {
    expect(rustNumber(/\bsidebar_width:\s*([\d.]+)/)).toBe(SIDEBAR.initial);
    expect(rustNumber(/\bpanel_height:\s*([\d.]+)/)).toBe(PANEL.initial);
    expect(rustNumber(/SplitRatio\s*\{\s*horizontal:\s*([\d.]+)/)).toBe(SPLIT.initial);
    expect(rustNumber(/SplitRatio\s*\{\s*horizontal:\s*[\d.]+,\s*vertical:\s*([\d.]+)/)).toBe(SPLIT.initial);
  });
});
