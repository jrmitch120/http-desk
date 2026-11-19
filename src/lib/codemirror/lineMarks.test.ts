import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { lineMarks, lineMarksIn, setLineMarks, type LineMark } from "./lineMarks";

const mark = (line: number): LineMark => ({ line, kind: "jetbrains-only", text: `line ${line}` });

describe("line markers", () => {
  it("move with their lines as text is typed, until the next marks arrive", () => {
    let state = EditorState.create({ doc: "GET /a\n# @no-log\n# @note\n", extensions: lineMarks() });
    state = state.update({ effects: setLineMarks.of([mark(2), mark(3), mark(9)]) }).state;
    // A line typed above the first marked one moves both down; a mark past the end stays.
    state = state.update({ changes: { from: 7, insert: "Accept: */*\n" } }).state;
    expect(lineMarksIn(state).map((m) => m.line)).toEqual([3, 4, 9]);
    // Text typed within a marked line leaves it where it is.
    state = state.update({ changes: { from: state.doc.line(3).to, insert: " x" } }).state;
    expect(lineMarksIn(state).map((m) => m.line)).toEqual([3, 4, 9]);
    state = state.update({ effects: setLineMarks.of([mark(1)]) }).state;
    expect(lineMarksIn(state)).toEqual([mark(1)]);
  });
});
