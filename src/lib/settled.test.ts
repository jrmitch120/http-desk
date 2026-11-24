import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settled } from "./settled.svelte";

describe("a value that settles before it updates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * A source the test changes, and the settled value following it. `track` runs on
   * each change, as the effect the store runs it from does.
   */
  function follow(first: number) {
    const source = { value: first };
    const settled = new Settled(() => source.value, 300);
    settled.track();
    const set = (value: number) => {
      source.value = value;
      settled.track();
    };
    return { settled, set };
  }

  it("starts at the source's value", () => {
    const { settled } = follow(2);
    expect(settled.current).toBe(2);
    vi.advanceTimersByTime(300);
    expect(settled.current).toBe(2);
  });

  it("stays put while the source keeps changing, and takes its value 300 ms after it stops", () => {
    const { settled, set } = follow(0);
    set(1);
    vi.advanceTimersByTime(200);
    set(2);
    vi.advanceTimersByTime(200);
    set(3);
    vi.advanceTimersByTime(299);
    // 699 ms of changes, none of them shown.
    expect(settled.current).toBe(0);
    vi.advanceTimersByTime(1);
    expect(settled.current).toBe(3);
  });
});
