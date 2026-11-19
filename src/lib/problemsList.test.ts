// What the Problems panel shows for the files the shell found something in: each
// file's entries by line, its portability summary, and the count on the panel's toggle.
import { describe, expect, it } from "vitest";
import { problemCount, problemFiles } from "./problemsList";
import type { FileProblems, PortabilityMark, Problem } from "./types";

const problem = (line: number, severity: Problem["severity"], message: string): Problem => ({ line, column: 1, severity, code: "unknown-directive", message });
const mark = (line: number, support: PortabilityMark["support"], hover: string): PortabilityMark => ({ line, construct: "x", support, label: "x", hover });

const PETS: FileProblems = {
  path: "/ws/pets.http",
  problems: [problem(3, "error", "Not a request line"), problem(9, "warning", "Unknown directive")],
  portability: [
    mark(5, "jetbrains-only", "Rider runs this handler; VS Code ignores it"),
    mark(5, "jetbrains-only", "Rider reads $random.uuid; VS Code doesn't"),
    mark(7, "jetbrains-only", "Rider honours # @no-log; VS Code ignores it"),
    mark(9, "vscode-only", "VS Code reads # @note; Rider ignores it"),
  ],
};
const API: FileProblems = { path: "/ws/a/api.http", problems: [problem(2, "error", "Missing file")], portability: [] };

describe("the Problems panel", () => {
  it("lists each file's entries by line, problems before notes on the same line", () => {
    const [api, pets] = problemFiles([PETS, API], "note");
    expect(api.path).toBe("/ws/a/api.http");
    expect(pets.entries.map((e) => [e.line, e.tone, e.message])).toEqual([
      [3, "error", "Not a request line"],
      [5, "note", "Rider runs this handler; VS Code ignores it"],
      [5, "note", "Rider reads $random.uuid; VS Code doesn't"],
      [7, "note", "Rider honours # @no-log; VS Code ignores it"],
      [9, "warning", "Unknown directive"],
      [9, "note", "VS Code reads # @note; Rider ignores it"],
    ]);
  });

  it("sums up each file's lines that behave differently in VS Code and in Rider", () => {
    const [api, pets] = problemFiles([PETS, API], "note");
    expect(pets.summary).toEqual(["2 lines behave differently in VS Code", "1 line behaves differently in Rider"]);
    expect(api.summary).toEqual([]);
  });

  it("shows portability notes as warnings when the setting asks for them", () => {
    const [, pets] = problemFiles([PETS, API], "warning");
    expect(pets.entries.filter((e) => e.line === 7).map((e) => e.tone)).toEqual(["warning"]);
  });

  it("counts problems on the toggle, and portability lines only when they're warnings", () => {
    expect(problemCount([PETS, API], "note")).toBe(3);
    expect(problemCount([PETS, API], "warning")).toBe(6);
    expect(problemCount([], "note")).toBe(0);
  });
});
