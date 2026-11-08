// What the Extract to variable form says about a name before anything is written.
import { describe, expect, it } from "vitest";
import { extractConflict, extractNameError, extractTargets } from "./extract";
import { newRequest } from "./http";
import type { EnvironmentSet, HttpFile } from "./types";

describe("extractNameError", () => {
  it("follows the File variable name rule, and refuses a leading $, which reads as a dynamic variable", () => {
    expect(extractNameError("baseUrl")).toBeNull();
    expect(extractNameError("api.v2-host_1")).toBeNull();
    expect(extractNameError("")).toBeNull();
    expect(extractNameError("base url")).toBe("Variable names can only use letters, digits, _, -, . and $");
    expect(extractNameError("a}}b")).toBe("Variable names can only use letters, digits, _, -, . and $");
    expect(extractNameError("$host")).toBe("A name starting with $ is read as a dynamic variable");
  });
});

describe("extractConflict", () => {
  const request = { ...newRequest("List"), variables: [{ name: "own", value: "1" }] };
  const file: HttpFile = {
    header: { comments: [], variables: [{ name: "host", value: "https://x" }], raw: null },
    requests: [request, { ...newRequest("Other"), variables: [{ name: "elsewhere", value: "2" }] }],
    trailing: "",
    lineEnding: "lf",
    bom: false,
  };
  const envSet: EnvironmentSet = {
    shared: [{ name: "version", value: "v1", secret: false }],
    environments: [
      { name: "local", variables: [{ name: "token", value: "t", secret: false }, { name: "baseUrl", value: "http://localhost", secret: false }] },
      { name: "staging", variables: [{ name: "token", value: "s", secret: true }] },
    ],
    privateFileIgnored: true,
  };
  const scope = { file, request, envSet };

  it("warns when the name is a File variable the request uses (at the top of the file or its own)", () => {
    expect(extractConflict({ kind: "file" }, "host", scope)).toBe("host is already a File variable; its value will be replaced.");
    expect(extractConflict({ kind: "file" }, "own", scope)).toBe("own is already a File variable; its value will be replaced.");
    expect(extractConflict({ kind: "file" }, "elsewhere", scope)).toBeNull();
    expect(extractConflict({ kind: "file" }, "token", scope)).toBeNull();
  });

  it("warns when the chosen environment, or any environment, already has the name", () => {
    expect(extractConflict({ kind: "env", env: "local" }, "baseUrl", scope)).toBe("local already has baseUrl; its value will be replaced.");
    expect(extractConflict({ kind: "env", env: "staging" }, "baseUrl", scope)).toBeNull();
    expect(extractConflict({ kind: "env", env: "staging" }, "token", scope)).toBe("staging already has token (a Secret); its value will be replaced.");
    expect(extractConflict({ kind: "all" }, "baseUrl", scope)).toBe("local already has baseUrl; its value will be replaced.");
    expect(extractConflict({ kind: "all" }, "token", scope)).toBe("local and staging already have token; their values will be replaced.");
    expect(extractConflict({ kind: "all" }, "version", scope)).toBeNull();
    expect(extractConflict({ kind: "file" }, "", scope)).toBeNull();
  });
});

describe("extractTargets", () => {
  const set = (...envs: string[]): EnvironmentSet => ({ shared: [], environments: envs.map((name) => ({ name, variables: [] })), privateFileIgnored: null });

  it("offers the selected environment only when the request's environments define it (ADR-0004: never another folder's)", () => {
    expect(extractTargets("dev", set("dev", "prod"))).toEqual([{ kind: "file" }, { kind: "env", env: "dev" }, { kind: "all" }]);
    expect(extractTargets("qa", set("dev", "prod"))).toEqual([{ kind: "file" }, { kind: "all" }]);
  });

  it("offers no environment destination without a selected environment or any environments", () => {
    expect(extractTargets(null, set("dev"))).toEqual([{ kind: "file" }, { kind: "all" }]);
    expect(extractTargets("dev", set())).toEqual([{ kind: "file" }]);
    expect(extractTargets("dev", null)).toEqual([{ kind: "file" }]);
  });
});
