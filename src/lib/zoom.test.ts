// The zoom levels Zoom In and Zoom Out step through, and how a saved zoom is read (#94).
import { describe, expect, it } from "vitest";
import shell from "../../src-tauri/src/lib.rs?raw";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_LEVELS, zoomIn, zoomOf, zoomOut } from "./zoom";

describe("the zoom levels", () => {
  it("run from 50% to 150%, with 100% among them", () => {
    expect(ZOOM_LEVELS).toEqual([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5]);
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.5, 1.5]);
  });

  it("match the range the Rust shell accepts", () => {
    const rust = (name: string) => Number(shell.match(new RegExp(`const ${name}: f64 = ([\\d.]+);`))?.[1]);
    expect([rust("MIN_ZOOM"), rust("MAX_ZOOM")]).toEqual([MIN_ZOOM, MAX_ZOOM]);
  });
});

describe("zoomIn and zoomOut", () => {
  it("move one level at a time", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(1.25)).toBe(1.5);
    expect(zoomIn(0.5)).toBe(0.67);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomOut(0.67)).toBe(0.5);
    expect(zoomOut(1.5)).toBe(1.25);
  });

  it("stop at the ends", () => {
    expect(zoomIn(MAX_ZOOM)).toBeNull();
    expect(zoomOut(MIN_ZOOM)).toBeNull();
  });

  it("move from a value between two levels to the next one up or down", () => {
    expect(zoomIn(1.05)).toBe(1.1);
    expect(zoomOut(1.05)).toBe(1);
    expect(zoomIn(1.4)).toBe(1.5);
    expect(zoomOut(0.55)).toBe(0.5);
  });

  it("treat a value a hair off a level as that level", () => {
    expect(zoomIn(0.6700000001)).toBe(0.75);
    expect(zoomOut(0.6699999999)).toBe(0.5);
  });
});

describe("zoomOf", () => {
  it("reads a saved zoom in range as written, levels or not", () => {
    expect(zoomOf(1.25)).toBe(1.25);
    expect(zoomOf(1.05)).toBe(1.05);
    expect(zoomOf(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(zoomOf(MAX_ZOOM)).toBe(MAX_ZOOM);
  });

  it("reads a missing, non-numeric or out-of-range zoom as 100%", () => {
    for (const odd of [undefined, null, "1.5", true, NaN, Infinity, 0, -1, 0.49, 1.51, 2, 3]) expect(zoomOf(odd)).toBe(1);
  });
});
