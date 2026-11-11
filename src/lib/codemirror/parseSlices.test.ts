// CodeMirror's background parse ends each slice when its idle deadline has 5 ms
// left (at least 25 ms in). Every deadline the app hands out reports at most
// IDLE_DEADLINE_MS left, so slices stay well under the 50 ms long-task budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_DEADLINE_MS, IDLE_PERIOD_MS, shortenIdleDeadlines } from "./parseSlices";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shortenIdleDeadlines", () => {
  it("caps the deadline of the browser's own requestIdleCallback and passes its options on", () => {
    let given: { callback: IdleRequestCallback; options?: IdleRequestOptions } | undefined;
    const cancel = vi.fn();
    const win = {
      requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
        given = { callback, options };
        return 7;
      },
      cancelIdleCallback: cancel,
    };
    shortenIdleDeadlines(win);
    const seen: number[] = [];
    expect(win.requestIdleCallback((d) => seen.push(d.timeRemaining()), { timeout: 400 })).toBe(7);
    expect(given!.options).toEqual({ timeout: 400 });
    given!.callback({ didTimeout: false, timeRemaining: () => 49.9 });
    given!.callback({ didTimeout: true, timeRemaining: () => 0 });
    given!.callback({ didTimeout: false, timeRemaining: () => 12 });
    expect(seen).toEqual([IDLE_DEADLINE_MS, 0, 12]);
    win.cancelIdleCallback(7);
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("supplies a requestIdleCallback where there is none, with the same cap", () => {
    let now = 1000;
    const win: Parameters<typeof shortenIdleDeadlines>[0] = {};
    shortenIdleDeadlines(win, () => now);
    const seen: number[] = [];
    win.requestIdleCallback!((d) => {
      seen.push(d.timeRemaining());
      now += IDLE_PERIOD_MS - 10;
      seen.push(d.timeRemaining());
      now += 20;
      seen.push(d.timeRemaining());
    });
    expect(seen).toEqual([]);
    vi.runAllTimers();
    expect(seen).toEqual([IDLE_DEADLINE_MS, 10, 0]);
  });

  it("cancels a supplied idle callback", () => {
    const win: Parameters<typeof shortenIdleDeadlines>[0] = {};
    shortenIdleDeadlines(win);
    const callback = vi.fn();
    win.cancelIdleCallback!(win.requestIdleCallback!(callback));
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
  });
});
