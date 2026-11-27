import { describe, expect, it } from "vitest";
import { portabilityLabel, portabilityOff } from "./portabilityLabel";

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

describe("portabilityOff", () => {
  it("is off only when no editor is turned on", () => {
    expect(portabilityOff({ vscode: false, rider: false })).toBe(true);
    expect(portabilityOff({ vscode: true, rider: false })).toBe(false);
    expect(portabilityOff({ vscode: false, rider: true })).toBe(false);
    expect(portabilityOff({ vscode: true, rider: true })).toBe(false);
  });
});
