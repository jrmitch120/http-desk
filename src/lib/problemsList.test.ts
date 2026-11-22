// What the Problems panel shows for the files the shell found something in: each
// file's entries by line, its portability summary, and the count on the panel's toggle.
import { describe, expect, it } from "vitest";
import { problemCount, problemFiles } from "./problemsList";
import type { FileProblems, HttpFile, PortabilityMark, Problem } from "./types";
import type { OutsideScope, PortabilitySettings } from "./checks";
import { invokeCore } from "../dev/textCore";

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
/** Both editors turned on (Settings → Portability), at the note level, or at `level`. */
const both = (level: PortabilitySettings["level"] = "note"): PortabilitySettings => ({ editors: { vscode: true, rider: true }, level });
const API: FileProblems = { path: "/ws/a/api.http", problems: [problem(2, "error", "Missing file")], portability: [] };

describe("the Problems panel", () => {
  it("lists each file's entries by line, problems before notes on the same line", () => {
    const [api, pets] = problemFiles([PETS, API], both());
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
    const [api, pets] = problemFiles([PETS, API], both());
    expect(pets.summary).toEqual(["2 lines behave differently in VS Code", "1 line behaves differently in Rider"]);
    expect(api.summary).toEqual([]);
  });

  it("shows portability notes as warnings when the setting asks for them", () => {
    const [, pets] = problemFiles([PETS, API], both("warning"));
    expect(pets.entries.filter((e) => e.line === 7).map((e) => e.tone)).toEqual(["warning"]);
  });

  it("counts problems on the toggle, and portability lines only when they're warnings", () => {
    expect(problemCount(problemFiles([PETS, API], both()))).toBe(3);
    expect(problemCount(problemFiles([PETS, API], both("warning")))).toBe(6);
    expect(problemCount(problemFiles([], both()))).toBe(0);
  });
});

describe("the Problems panel's portability rows, by the editors turned on", () => {
  const only = (editor: "vscode" | "rider" | null, level: PortabilitySettings["level"] = "note"): PortabilitySettings => ({
    editors: { vscode: editor === "vscode", rider: editor === "rider" },
    level,
  });

  it("has none while both editors are off, leaving the problems", () => {
    const [api, pets] = problemFiles([PETS, API], only(null, "warning"));
    expect(pets.entries.map((e) => e.message)).toEqual(["Not a request line", "Unknown directive"]);
    expect(pets.summary).toEqual([]);
    expect(problemCount([api, pets])).toBe(3);
  });

  it("with only VS Code on, lists only what VS Code reads differently, and sums up only VS Code", () => {
    const [, pets] = problemFiles([PETS, API], only("vscode"));
    expect(pets.entries.filter((e) => e.tone === "note").map((e) => e.message)).toEqual([
      "Rider runs this handler; VS Code ignores it",
      "Rider reads $random.uuid; VS Code doesn't",
      "Rider honours # @no-log; VS Code ignores it",
    ]);
    expect(pets.summary).toEqual(["2 lines behave differently in VS Code"]);
  });

  it("with only Rider on and warnings on, counts only Rider's lines", () => {
    const [, pets] = problemFiles([PETS, API], only("rider", "warning"));
    expect(pets.entries.filter((e) => e.message.startsWith("VS Code reads")).map((e) => e.tone)).toEqual(["warning"]);
    expect(pets.entries.some((e) => e.message.startsWith("Rider"))).toBe(false);
    expect(pets.summary).toEqual(["1 line behaves differently in Rider"]);
    expect(pets.count).toBe(3);
  });

  it("lists a file again when an editor is turned on, though it and the level are the same", () => {
    const memo = new WeakMap();
    expect(problemFiles([PETS], only(null), undefined, undefined, memo)[0].summary).toEqual([]);
    expect(problemFiles([PETS], only("rider"), undefined, undefined, memo)[0].summary).toEqual(["1 line behaves differently in Rider"]);
  });
});

describe("the Problems panel's Undefined variables and shared names", () => {
  // As the shell sends a file it found references in: what its text reads as (the real core, WASM).
  const TEXT = "@host = https://example.com\n\n### List\n# @name list\nGET {{host}}/books?key={{apiKey}}\n\n### Again\n# @name list\nGET {{host}}/{{token}}\nX-Id: {{$uuid}}\n";
  const REFS: FileProblems = { path: "/ws/books.http", problems: [], portability: [], file: invokeCore<HttpFile>("parse_file", { text: TEXT }) };
  const outside = (env: Record<string, string> = {}, globals: Record<string, string> = {}): OutsideScope => ({
    env: Object.fromEntries(Object.entries(env).map(([name, value]) => [name, { value, secret: false, source: "dev" }])),
    envName: "dev",
    globals,
  });
  const entries = (o: OutsideScope) => problemFiles([REFS], both(), () => o)[0]?.entries.map((e) => [e.line, e.tone, e.message]) ?? [];

  it("lists each reference a send would leave undefined, and each # @name another request shares, at its line", () => {
    expect(entries(outside())).toEqual([
      [4, "warning", "# @name list is also the name of another request in this file"],
      [5, "warning", "{{apiKey}} is undefined"],
      [8, "warning", "# @name list is also the name of another request in this file"],
      [9, "warning", "{{token}} is undefined"],
    ]);
    expect(problemCount(problemFiles([REFS], both(), () => outside()))).toBe(4);
  });

  it("knows the environment and the Session's Global variables, as a send does", () => {
    expect(entries(outside({ apiKey: "k" }, { token: "t" })).map(([line]) => line)).toEqual([4, 8]);
  });

  it("lists nothing for a file whose references are all defined", () => {
    const fine: FileProblems = { ...REFS, file: invokeCore<HttpFile>("parse_file", { text: "@host = x\n### A\nGET {{host}}\n" }) };
    expect(problemFiles([fine], both(), () => outside())).toEqual([]);
  });
});
