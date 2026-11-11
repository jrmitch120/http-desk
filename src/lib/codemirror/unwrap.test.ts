// Which bodies may be shown unwrapped: only those whose every line CodeMirror
// draws at its real width (#119).
import { describe, expect, it } from "vitest";
import { canUnwrap } from "./unwrap";
import { textDoc } from "./docBuilder";

const line = (n: number) => "x".repeat(n);

describe("canUnwrap", () => {
  it("allows a body whose longest line is at most 200,000 characters", () => {
    expect(canUnwrap(textDoc(line(199_999)))).toBe(true);
    expect(canUnwrap(textDoc(line(200_000)))).toBe(true);
  });

  it("refuses a body with a line over 200,000 characters", () => {
    expect(canUnwrap(textDoc(line(200_001)))).toBe(false);
  });

  it("refuses a body whose long line is anywhere, not only first", () => {
    expect(canUnwrap(textDoc(["{", `  "blob": "${line(200_000)}"`, "}"].join("\n")))).toBe(false);
  });
});
