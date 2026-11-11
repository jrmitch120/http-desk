import { describe, expect, it, vi } from "vitest";
import { nextTask, slices } from "./timeSlices";

describe("nextTask", () => {
  it("resolves in a later task, after work already queued, in order", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timeout"));
    const a = nextTask().then(() => order.push("a"));
    const b = nextTask().then(() => order.push("b"));
    order.push("now");
    await Promise.all([a, b]);
    expect(order.slice(0, 1)).toEqual(["now"]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });
});

describe("slices", () => {
  it("pauses only once the slice's time is up, then starts a new slice", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const slice = slices(8);
    expect(slice.due()).toBe(false);
    let paused = false;
    await slice.pause().then(() => (paused = true));
    expect(paused).toBe(true); // at once: not due

    now = 8;
    expect(slice.due()).toBe(true);
    const pause = slice.pause();
    now = 9;
    await pause;
    expect(slice.due()).toBe(false); // a new slice started after the pause
    now = 17;
    expect(slice.due()).toBe(true);
    vi.restoreAllMocks();
  });
});
