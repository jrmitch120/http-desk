// Building an editor document from a body's bytes in pieces: whatever the
// piece boundaries split, the document is the one CodeMirror makes from the
// whole text at once.
import { describe, expect, it } from "vitest";
import { EditorState, type Text } from "@codemirror/state";
import { buildDoc, DocBuilder, longestLine, PIECE_BYTES, textDoc } from "./docBuilder";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The document CodeMirror itself makes from `text`. */
const expected = (text: string): Text => EditorState.create({ doc: text }).doc;

/** Builds `bytes`, cut into pieces at each of `cuts`. */
function build(bytes: Uint8Array, cuts: number[]): Text {
  const b = new DocBuilder();
  let from = 0;
  for (const to of [...cuts, bytes.length]) {
    b.push(bytes.subarray(from, to));
    from = to;
  }
  return b.finish();
}

function expectDoc(doc: Text, text: string) {
  expect(doc.toString()).toBe(expected(text).toString());
  expect(doc.lines).toBe(expected(text).lines);
}

describe("DocBuilder", () => {
  it("joins a multi-byte character split across two pieces", () => {
    const text = 'name: "café ☕ 𝄞"\nnext';
    const bytes = utf8(text);
    // Every cut, so each multi-byte character is split at each of its bytes.
    for (let cut = 1; cut < bytes.length; cut++) expectDoc(build(bytes, [cut]), text);
  });

  it("reads \\r\\n split across pieces as one line break", () => {
    const text = "first\r\nsecond\r\nthird";
    const cut = text.indexOf("\r") + 1;
    expectDoc(build(utf8(text), [cut]), text);
    expect(build(utf8(text), [cut]).lines).toBe(3);
  });

  it("reads a lone \\r at the end of a piece as a line break", () => {
    const text = "first\rsecond\r";
    expectDoc(build(utf8(text), [6]), text);
    expectDoc(build(utf8(text), [12]), text);
  });

  it("builds an empty body as an empty document", () => {
    expectDoc(build(new Uint8Array(0), []), "");
    expect(new DocBuilder().finish().length).toBe(0);
  });

  it("keeps the empty last line of a body ending in a newline", () => {
    const text = "a\nb\n";
    expectDoc(build(utf8(text), [2]), text);
    expectDoc(build(utf8(text), [4]), text);
    expect(build(utf8(text), [4]).lines).toBe(3);
  });

  it("builds a single long line spanning many pieces", () => {
    const text = "x".repeat(10_000) + "é".repeat(5_000);
    const bytes = utf8(text);
    const cuts = Array.from({ length: Math.floor(bytes.length / 997) }, (_, i) => (i + 1) * 997);
    const doc = build(bytes, cuts);
    expectDoc(doc, text);
    expect(doc.lines).toBe(1);
  });

  it("builds a body exactly one piece long", async () => {
    const line = "0123456789abcde\n"; // 16 bytes, so lines end exactly at the piece end
    const text = line.repeat(PIECE_BYTES / 16);
    const bytes = utf8(text);
    expect(bytes.length).toBe(PIECE_BYTES);
    const pauses: number[] = [];
    const doc = await buildDoc(bytes.buffer, async () => void pauses.push(1));
    expectDoc(doc, text);
    expect(pauses).toEqual([]); // one piece, nothing to wait between
  });
});

describe("buildDoc", () => {
  it("builds a body of many pieces, pausing between them and around the end", async () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `{"id":${i},"name":"pet-${i}","note":"ü"}`);
    const text = lines.join("\r\n");
    const bytes = utf8(text);
    let pauses = 0;
    const doc = await buildDoc(bytes.buffer, async () => void pauses++);
    expectDoc(doc, text);
    expect(pauses).toBe(Math.ceil(bytes.length / PIECE_BYTES) + 1);
  });

  it("builds a line longer than a piece, and one running to the end", async () => {
    const long = "y".repeat(2 * PIECE_BYTES + 3);
    for (const text of [`a\n${long}\nb`, `a\n${long}`, long]) {
      expectDoc(await buildDoc(utf8(text).buffer, async () => {}), text);
    }
  });
});

describe("longestLine", () => {
  it("is noted while building, whatever the pieces split", async () => {
    const long = "x".repeat(3 * PIECE_BYTES + 7); // across four pieces
    const text = ["short", long, "also short"].join("\n");
    const doc = await buildDoc(utf8(text).buffer, async () => {});
    expect(longestLine(doc)).toBe(long.length);
  });

  it("is noted for a text built at once, and measured for any other document", () => {
    expect(longestLine(textDoc("ab\r\nabcd\nabc"))).toBe(4);
    expect(longestLine(expected("a\nabcde\n"))).toBe(5);
  });
});
