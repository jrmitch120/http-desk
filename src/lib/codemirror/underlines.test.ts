import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { checkUnderlines, setUnderlines, underlines, underlinesAt } from "./underlines";
import type { Check } from "../checks";
import type { Problem } from "../types";

const SOURCE = ["### Broken", "# @nmae x", "# @name login", "POST {{baseUrl}}/pets two", "#~ X-Off: {{token}}", "", "< ./payload.json  ", ""].join("\n");

/** The underlined text of each underline, with its severity and message. */
const marked = (text: string, checks: Check[]) => checkUnderlines(text, checks).map((u) => [text.slice(u.from, u.to), u.severity, u.message]);
const problem = (line: number, column: number, code: Problem["code"], severity: Problem["severity"] = "warning"): Check => ({
  kind: "problem",
  problem: { line, column, severity, code, message: `${code} here` },
});

describe("underlines in the request's source", () => {
  it("underline each problem from its column to the end of its line, with its message", () => {
    const checks = [problem(2, 3, "unknown-directive"), problem(4, 1, "unparseable-request-line", "error"), problem(7, 1, "missing-file", "error")];
    expect(marked(SOURCE, checks)).toEqual([
      ["@nmae x", "warning", "unknown-directive here"],
      ["POST {{baseUrl}}/pets two", "error", "unparseable-request-line here"],
      ["< ./payload.json", "error", "missing-file here"],
    ]);
  });

  it("count a problem's column in characters, not UTF-16 units", () => {
    expect(marked("# 🙂 @nmae\n", [problem(1, 5, "unknown-directive")])).toEqual([["@nmae", "warning", "unknown-directive here"]]);
  });

  it("underline each sent reference to an Undefined variable, and a duplicate # @name's line", () => {
    const checks: Check[] = [
      { kind: "undefined", name: "baseUrl", sections: ["url"], fixes: [] },
      { kind: "undefined", name: "token", sections: ["headers"], fixes: [] },
      { kind: "duplicateName", name: "login", others: 1 },
      { kind: "riderRefuses", name: "login" },
    ];
    expect(marked(SOURCE, checks)).toEqual([
      ["@name login", "warning", "# @name login is also the name of another request in this file"],
      ["{{baseUrl}}", "warning", "{{baseUrl}} is undefined"],
    ]);
  });

  it("leave out a problem whose line the text doesn't have", () => {
    expect(marked("GET /\n", [problem(9, 1, "header-after-body")])).toEqual([]);
  });

  it("show in an editor, follow its edits, and give their messages where they are", () => {
    let state = EditorState.create({ doc: SOURCE, extensions: underlines() });
    state = state.update({ effects: setUnderlines.of(checkUnderlines(SOURCE, [problem(4, 1, "unparseable-request-line", "error")])) }).state;
    const at = SOURCE.indexOf("pets two");
    expect(underlinesAt(state, at).map((u) => u.message)).toEqual(["unparseable-request-line here"]);
    expect(underlinesAt(state, 0)).toEqual([]);
    state = state.update({ changes: { from: 0, insert: "# a comment\n" } }).state;
    expect(underlinesAt(state, at + 12).map((u) => u.message)).toEqual(["unparseable-request-line here"]);
  });
});
