// CodeMirror's background parse asks `navigator.scheduling.isInputPending()`
// as it goes; once a task has run PARSE_SLICE_MS, the answer is yes, so the
// slice ends, and a new task starts counting afresh.
import { describe, expect, it } from "vitest";
import { limitParseSlices, PARSE_SLICE_MS } from "./parseSlices";

function setUp(native?: () => boolean) {
  let now = 1000;
  let nextTask: (() => void)[] = [];
  const nav: { scheduling?: { isInputPending?: () => boolean } } = native ? { scheduling: { isInputPending: native } } : {};
  limitParseSlices(
    nav,
    () => now,
    (f) => nextTask.push(f),
  );
  return {
    ask: () => nav.scheduling!.isInputPending!(),
    advance: (ms: number) => (now += ms),
    newTask: () => {
      const run = nextTask;
      nextTask = [];
      run.forEach((f) => f());
    },
  };
}

describe("limitParseSlices", () => {
  it("says input is pending once the task has run for the slice limit, and not in the next task", () => {
    const s = setUp();
    expect(s.ask()).toBe(false);
    s.advance(PARSE_SLICE_MS - 1);
    expect(s.ask()).toBe(false);
    s.advance(1);
    expect(s.ask()).toBe(true);
    s.newTask();
    expect(s.ask()).toBe(false);
  });

  it("still says so when the browser reports pending input", () => {
    const s = setUp(() => true);
    expect(s.ask()).toBe(true);
    s.newTask();
  });
});
