import { describe, expect, it } from "vitest";
import { portabilityLabel } from "./portabilityLabel";

describe("portabilityLabel", () => {
  it("names the one editor turned on", () => {
    expect(portabilityLabel({ vscode: true, rider: false })).toBe("VS Code");
    expect(portabilityLabel({ vscode: false, rider: true })).toBe("Rider");
  });
  it("names both, VS Code first, when both are on", () => {
    expect(portabilityLabel({ vscode: true, rider: true })).toBe("VS Code · Rider");
  });
  it("says HttpDesk only when both are off", () => {
    expect(portabilityLabel({ vscode: false, rider: false })).toBe("HttpDesk only");
  });
});
