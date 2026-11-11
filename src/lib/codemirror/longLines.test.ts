// Bodies with long lines (#119): wrapped, which lines CodeMirror draws only in
// part (and so break at any character); unwrapped, which bodies it can draw at all.
import { describe, expect, it } from "vitest";
import { canUnwrap, hasLongLines } from "./longLines";
import { textDoc } from "./docBuilder";

const line = (n: number) => "x".repeat(n);

describe("hasLongLines", () => {
  it("is false for a body whose lines are all under 20,000 characters", () => {
    expect(hasLongLines(textDoc([line(19_999), line(10)].join("\n")))).toBe(false);
  });

  it("is true from 20,000 characters, where CodeMirror starts drawing a wrapped line in part", () => {
    expect(hasLongLines(textDoc(line(20_000)))).toBe(true);
    expect(hasLongLines(textDoc(["{", `  "blob": "${line(30_000)}"`, "}"].join("\n")))).toBe(true);
  });
});

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
