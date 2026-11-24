import { describe, expect, it } from "vitest";
import { shownProblemCount } from "./problemCount";

describe("shownProblemCount", () => {
  it("shows the count up to 99, zero included", () => {
    expect(shownProblemCount(0)).toBe("0");
    expect(shownProblemCount(7)).toBe("7");
    expect(shownProblemCount(99)).toBe("99");
  });
  it("shows counts above 99 as 99+, so they fit the status bar's fixed width", () => {
    expect(shownProblemCount(100)).toBe("99+");
    expect(shownProblemCount(4321)).toBe("99+");
  });
});
