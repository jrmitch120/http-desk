// The Environments matrix (#83): variables as rows, Shared and each environment
// as columns. These cover what each cell shows and what an edit does to the
// environment set that `save_environments` writes.
import { describe, expect, it } from "vitest";
import type { EnvironmentSet, EnvVar } from "./types";
import { addToAllEnvironments, matrixCell, matrixColumns, matrixNames, removeEverywhere, rowMatches, setCell } from "./envMatrix";

const v = (name: string, value: string, secret = false): EnvVar => ({ name, value, secret });

function sample(): EnvironmentSet {
  return {
    shared: [v("version", "v1")],
    environments: [
      { name: "local", variables: [v("baseUrl", "http://localhost"), v("token", "dev", true)] },
      { name: "staging", variables: [v("baseUrl", "https://staging")] },
    ],
    privateFileIgnored: true,
  };
}

describe("rows and columns", () => {
  it("has a column for Shared, then one per environment", () => {
    expect(matrixColumns(sample())).toEqual(["$shared", "local", "staging"]);
  });

  it("lists every variable once, in the order first seen from Shared through the environments", () => {
    expect(matrixNames(sample())).toEqual(["version", "baseUrl", "token"]);
  });

  it("leaves out rows still being named in the list view", () => {
    const set = sample();
    set.environments[1].variables.push(v("  ", "x"), v(" host ", "h"));
    expect(matrixNames(set)).toEqual(["version", "baseUrl", "token", "host"]);
  });
});

describe("what a cell shows", () => {
  it("is a gap when the environment doesn't define the variable and Shared doesn't either", () => {
    const set = sample();
    expect(matrixCell(set, "staging", "token")).toEqual({ state: "gap" });
    expect(matrixCell(set, "local", "token")).toEqual({ state: "set", variable: v("token", "dev", true) });
  });

  it("isn't a gap when the shared variables supply it", () => {
    expect(matrixCell(sample(), "local", "version")).toEqual({ state: "shared" });
  });

  it("is never a gap in the Shared column, which is optional", () => {
    expect(matrixCell(sample(), "$shared", "baseUrl")).toEqual({ state: "unset" });
  });

  it("is defined even when its value is empty, as after adding to all environments", () => {
    const set = sample();
    set.environments[1].variables.push(v("token", ""));
    expect(matrixCell(set, "staging", "token").state).toBe("set");
  });

  it("shows the last of two same-named rows, the one sending uses", () => {
    const set = sample();
    set.environments[1].variables.push(v("baseUrl", "https://second"));
    expect(matrixCell(set, "staging", "baseUrl")).toEqual({ state: "set", variable: v("baseUrl", "https://second") });
  });
});

describe("editing a cell", () => {
  it("changes the column's own variable", () => {
    const set = sample();
    setCell(set, "staging", "baseUrl", { value: "https://stage2" });
    expect(set.environments[1].variables).toEqual([v("baseUrl", "https://stage2")]);
    expect(set.environments[0].variables[0].value).toBe("http://localhost");
  });

  it("fills a gap by adding the variable to that environment only", () => {
    const set = sample();
    setCell(set, "staging", "token", { value: "abc" });
    expect(set.environments[1].variables).toEqual([v("baseUrl", "https://staging"), v("token", "abc")]);
    expect(matrixCell(set, "staging", "token").state).toBe("set");
    expect(set.shared).toEqual([v("version", "v1")]);
  });

  it("makes the cell's variable a Secret without touching other environments", () => {
    const set = sample();
    setCell(set, "staging", "baseUrl", { secret: true });
    expect(set.environments[1].variables).toEqual([v("baseUrl", "https://staging", true)]);
    expect(set.environments[0].variables[0]).toEqual(v("baseUrl", "http://localhost"));
  });

  it("can make a gap a Secret before its value is typed", () => {
    const set = sample();
    setCell(set, "staging", "token", { secret: true });
    expect(set.environments[1].variables[1]).toEqual(v("token", "", true));
  });
});

describe("adding a variable to all environments", () => {
  it("adds it, empty, to every environment, but not to Shared", () => {
    const set = sample();
    expect(addToAllEnvironments(set, " apiKey ")).toBe(2);
    expect(set.environments.map((e) => e.variables.at(-1))).toEqual([v("apiKey", ""), v("apiKey", "")]);
    expect(set.shared).toEqual([v("version", "v1")]);
    expect(matrixNames(set).at(-1)).toBe("apiKey");
  });

  it("only fills the environments that don't have it, keeping existing values", () => {
    const set = sample();
    expect(addToAllEnvironments(set, "token")).toBe(1);
    expect(set.environments[0].variables).toEqual([v("baseUrl", "http://localhost"), v("token", "dev", true)]);
    expect(set.environments[1].variables).toEqual([v("baseUrl", "https://staging"), v("token", "")]);
  });
});

it("the filter matches a row by name, or by a shareable value in any column (never a Secret's)", () => {
  const set = sample();
  expect(matrixNames(set).filter((n) => rowMatches(set, n, "TOK"))).toEqual(["token"]);
  expect(matrixNames(set).filter((n) => rowMatches(set, n, "staging"))).toEqual(["baseUrl"]);
  expect(matrixNames(set).filter((n) => rowMatches(set, n, "dev"))).toEqual([]);
  expect(matrixNames(set).filter((n) => rowMatches(set, n, " "))).toEqual(["version", "baseUrl", "token"]);
});

it("deleting a row removes the variable from Shared and every environment", () => {
  const set = sample();
  set.shared.push(v("baseUrl", "http://shared"));
  removeEverywhere(set, "baseUrl");
  expect(matrixNames(set)).toEqual(["version", "token"]);
  expect(set.shared).toEqual([v("version", "v1")]);
});
