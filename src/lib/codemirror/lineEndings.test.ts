// An editor on a file with mixed line endings keeps each line's own: what isn't edited
// comes back byte for byte, and a line break typed anew gets the file's ending.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { keepLineEndings, readEndings, setEndings, textWithEndings, type LineBreak } from "./lineEndings";

/** An editor holding `text`, as Editor.svelte makes one for a file whose own ending is `newBreak`. */
function editor(text: string, newBreak: LineBreak) {
  const { doc, others } = readEndings(text, newBreak);
  let state = EditorState.create({ doc, extensions: keepLineEndings(others) });
  return {
    type(from: number, to: number, insert: string) {
      state = state.update({ changes: { from, to, insert } }).state;
    },
    replaceAll(next: string) {
      const read = readEndings(next, newBreak);
      state = state.update({ changes: { from: 0, to: state.doc.length, insert: read.doc }, effects: setEndings.of(read.others) }).state;
    },
    get text() {
      return textWithEndings(state, newBreak);
    },
    get doc() {
      return state.doc.toString();
    },
  };
}

describe("an editor keeping each line's ending", () => {
  // Mostly CRLF, one LF line (the `Accept` one).
  const MOSTLY_CRLF = "### A\r\nGET https://x\r\nAccept: */*\n\r\n### B\r\nGET https://y\r\n";

  it("gives the text back byte for byte until it's edited", () => {
    expect(editor(MOSTLY_CRLF, "\r\n").text).toBe(MOSTLY_CRLF);
    expect(editor("a\nb\r\nc\n", "\n").text).toBe("a\nb\r\nc\n");
    expect(editor("no break", "\n").text).toBe("no break");
  });

  it("keeps a line's ending when the line is edited, and gives a new line the file's ending", () => {
    const e = editor(MOSTLY_CRLF, "\r\n");
    const at = e.doc.indexOf("*/*") + 3;
    e.type(at, at, "\nX-Added: 1");
    expect(e.text).toBe("### A\r\nGET https://x\r\nAccept: */*\r\nX-Added: 1\n\r\n### B\r\nGET https://y\r\n");
  });

  it("forgets the ending of a line break that's deleted", () => {
    const e = editor(MOSTLY_CRLF, "\r\n");
    const at = e.doc.indexOf("*/*") + 3;
    e.type(at, at + 1, "");
    expect(e.text).toBe("### A\r\nGET https://x\r\nAccept: */*\r\n### B\r\nGET https://y\r\n");
  });

  it("takes each line's ending from new text put in whole", () => {
    const e = editor(MOSTLY_CRLF, "\r\n");
    e.replaceAll("x\ny\r\n");
    expect(e.text).toBe("x\ny\r\n");
  });

  it("writes a lone \\r break with the file's ending", () => {
    expect(editor("a\rb\n", "\n").text).toBe("a\nb\n");
  });
});
