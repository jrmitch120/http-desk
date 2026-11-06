import { describe, expect, it } from "vitest";
import { place } from "./place";

const viewport = { width: 1000, height: 800 };
const size = { width: 80, height: 30 };
// A 30x26 button in the top-left area.
const button = { left: 100, top: 50, right: 130, bottom: 76 };

describe("place", () => {
  it("puts the popup under the anchor, aligned to its start, with a gap", () => {
    expect(place(button, size, viewport)).toEqual({ x: 100, y: 80, side: "bottom" });
  });

  it("centres it on the anchor when asked", () => {
    // Anchor centre is 115; an 80px popup starts 40px left of it.
    expect(place(button, size, viewport, { align: "center" })).toEqual({ x: 75, y: 80, side: "bottom" });
  });

  it("aligns its end with the anchor's end", () => {
    expect(place(button, size, viewport, { align: "end" })).toEqual({ x: 50, y: 80, side: "bottom" });
  });

  it("flips above the anchor when there's no room below", () => {
    const low = { left: 100, top: 760, right: 130, bottom: 786 };
    expect(place(low, size, viewport)).toEqual({ x: 100, y: 726, side: "top" });
  });

  it("goes above when asked, and flips below when there's no room above", () => {
    expect(place({ left: 100, top: 400, right: 130, bottom: 426 }, size, viewport, { side: "top" })).toEqual({ x: 100, y: 366, side: "top" });
    const high = { left: 100, top: 20, right: 130, bottom: 46 };
    expect(place(high, size, viewport, { side: "top" })).toEqual({ x: 100, y: 50, side: "bottom" });
  });

  it("keeps it inside the viewport horizontally", () => {
    const right = { left: 980, top: 50, right: 1000, bottom: 76 };
    expect(place(right, size, viewport)).toEqual({ x: 914, y: 80, side: "bottom" });
    const left = { left: 0, top: 50, right: 20, bottom: 76 };
    expect(place(left, size, viewport, { align: "center" })).toEqual({ x: 6, y: 80, side: "bottom" });
  });

  it("uses the roomier side and clamps when it fits on neither", () => {
    const tall = { width: 80, height: 500 };
    const middle = { left: 100, top: 300, right: 130, bottom: 326 };
    // 474px below vs 300px above: stays below, pulled up to end 6px from the bottom.
    expect(place(middle, tall, viewport)).toEqual({ x: 100, y: 294, side: "bottom" });
  });

  it("places a menu at a pointer position (a zero-size anchor)", () => {
    const point = { left: 500, top: 400, right: 500, bottom: 400 };
    expect(place(point, { width: 190, height: 120 }, viewport, { gap: 0 })).toEqual({ x: 500, y: 400, side: "bottom" });
    const nearCorner = { left: 950, top: 750, right: 950, bottom: 750 };
    expect(place(nearCorner, { width: 190, height: 120 }, viewport, { gap: 0 })).toEqual({ x: 804, y: 630, side: "top" });
  });
});
