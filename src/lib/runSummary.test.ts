import { describe, expect, it } from "vitest";
import { runSummary } from "./runSummary";
import type { RunItemState } from "./runner.svelte";

const items = (...states: RunItemState[]) => states.map((state) => ({ state }));

describe("runSummary", () => {
  it("mid-run, counts finished requests (passed and failed) out of all", () => {
    expect(runSummary(items("passed", "passed", "sending", "queued"), true)).toEqual({
      label: "Run 2/4",
      failed: "",
      text: "Run 2/4",
      passedShare: 0.5,
      failedShare: 0,
      sendingShare: 0.25,
    });
  });

  it("mid-run with failures, adds the failed count and its share", () => {
    const s = runSummary(items("passed", "failed", "sending", "queued"), true);
    expect(s.label).toBe("Run 2/4");
    expect(s.failed).toBe("· 1 failed");
    expect(s.text).toBe("Run 2/4 · 1 failed");
    expect(s.passedShare).toBe(0.25);
    expect(s.failedShare).toBe(0.25);
  });

  it("a finished run with no failures reads just its passed count", () => {
    expect(runSummary(items("passed", "passed", "passed"), false)).toMatchObject({ label: "Run: 3 passed", failed: "", text: "Run: 3 passed" });
  });

  it("a finished run with failures reads passed then failed", () => {
    expect(runSummary(items("passed", "failed", "passed"), false)).toMatchObject({ label: "Run: 2 passed", failed: "· 1 failed", text: "Run: 2 passed · 1 failed" });
  });

  it("a finished run where every request failed", () => {
    expect(runSummary(items("failed", "failed"), false)).toMatchObject({ label: "Run: 0 passed", failed: "· 2 failed", text: "Run: 0 passed · 2 failed", passedShare: 0, failedShare: 1 });
  });

  it("a run stopped before any request finished reads stopped at 0", () => {
    expect(runSummary(items("cancelled", "notRun", "notRun"), false)).toMatchObject({ label: "Run stopped: 0/3", failed: "", text: "Run stopped: 0/3", passedShare: 0, failedShare: 0, sendingShare: 0 });
  });

  it("a run stopped part-way (by Stop or by Stop on first failure) reads how far it got", () => {
    expect(runSummary(items("passed", "failed", "notRun", "notRun"), false)).toMatchObject({ label: "Run stopped: 2/4", failed: "· 1 failed", text: "Run stopped: 2/4 · 1 failed" });
  });

  it("a single request, sending then passed", () => {
    expect(runSummary(items("sending"), true)).toEqual({ label: "Run 0/1", failed: "", text: "Run 0/1", passedShare: 0, failedShare: 0, sendingShare: 1 });
    expect(runSummary(items("passed"), false)).toMatchObject({ label: "Run: 1 passed", failed: "" });
  });

  it("an empty run has no shares", () => {
    expect(runSummary([], false)).toEqual({ label: "Run: 0 passed", failed: "", text: "Run: 0 passed", passedShare: 0, failedShare: 0, sendingShare: 0 });
  });
});
