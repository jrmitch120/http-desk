// The requests of a file view's text: where each one is, what the outline calls it,
// and which one a cursor position is in.
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { TreeFragment } from "@lezer/common";
import { requestAt, requestBlocks } from "./outline";
import { httpLanguage } from "./http";

const FILE = [
  "@host = example.com", // 1  file variables: no request
  "",
  "### List pets", // 3
  "# @name list",
  "GET https://{{host}}/pets", // 5
  "Accept: application/json",
  "",
  "### ", // 8: a blank title
  "# @name create",
  "POST https://{{host}}/pets", // 10
  "Content-Type: application/json",
  "",
  "{", // 13
  '  "name": "Rex"',
  "}",
  "",
  "> {%", // 17
  "  client.global.set('id', response.body.id);",
  "%}",
  "",
  "###", // 21
  "# just a note, no request",
  "",
  "###", // 24
  "DELETE https://{{host}}/pets/1",
  "",
].join("\n");

/** The offset of `col` (0-based) on line `n` (1-based) of `text`. */
function at(text: string, n: number, col = 0): number {
  return text.split("\n").slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0) + col;
}

describe("requestBlocks", () => {
  it("lists each request in order, by its ### title, else its @name, else its method and URL", () => {
    expect(requestBlocks(FILE).map((b) => [b.index, b.method, b.label])).toEqual([
      [0, "GET", "List pets"],
      [1, "POST", "create"],
      [2, "DELETE", "DELETE https://{{host}}/pets/1"],
    ]);
  });

  it("starts each request at its ### line, else at its request line", () => {
    expect(requestBlocks(FILE).map((b) => b.start)).toEqual([at(FILE, 3), at(FILE, 8), at(FILE, 24)]);
    expect(requestBlocks("# a comment\nGET https://example.com\n")[0].start).toBe(at("# a comment\nGET https://example.com\n", 2));
  });

  it("finds nothing in text without a request", () => {
    expect(requestBlocks("")).toEqual([]);
    expect(requestBlocks("@host = example.com\n# notes\n")).toEqual([]);
  });
});

describe("requestAt", () => {
  const blocks = requestBlocks(FILE);
  const under = (line: number, col = 0) => requestAt(blocks, at(FILE, line, col))?.index ?? null;

  it("finds the request on its request line, headers, body and handler", () => {
    expect(under(5, 4)).toBe(0); // request line
    expect(under(6, 3)).toBe(0); // header
    expect(under(14, 4)).toBe(1); // body
    expect(under(18, 10)).toBe(1); // handler
    expect(under(25)).toBe(2);
  });

  it("finds the request on its ### line and the lines before its request line", () => {
    expect(under(3)).toBe(0);
    expect(under(3, "### List pets".length)).toBe(0);
    expect(under(4, 3)).toBe(0); // # @name
    expect(under(8)).toBe(1);
  });

  it("counts the blank lines after a request as its own", () => {
    expect(under(7)).toBe(0);
    expect(under(20)).toBe(1);
  });

  it("finds none in the file variables or a block without a request", () => {
    expect(under(1, 3)).toBeNull();
    expect(under(2)).toBeNull();
    expect(under(22, 4)).toBeNull();
  });
});

describe("the requests of an editor's tree, after an edit (#168)", () => {
  /** `text` edited (`insert` at `from`–`to`), and its tree parsed again from the tree before. */
  function edit(text: string, from: number, to: number, insert: string) {
    const before = httpLanguage.parser.parse(text);
    const after = text.slice(0, from) + insert + text.slice(to);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(before), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    return { before, text: after, tree: httpLanguage.parser.parse(after, fragments) };
  }

  it("are read as from the text, and the requests an edit didn't touch keep their outline entries", () => {
    // In the last request: the text before it is long enough for its fragment to be kept.
    const { before, text, tree } = edit(FILE, at(FILE, 25, 6), at(FILE, 25, 6), "S");
    const old = requestBlocks(FILE, before);
    const now = requestBlocks(Text.of(text.split("\n")), tree);
    expect(now.map(({ entry: _, ...b }) => b)).toEqual(requestBlocks(text).map(({ entry: _, ...b }) => b));
    expect(now[0].entry).toBe(old[0].entry);
    expect(now[1].entry).toBe(old[1].entry);
    expect(now[2].entry).not.toBe(old[2].entry);
    expect(now[2].label).toBe("DELETES https://{{host}}/pets/1");
  });
});
