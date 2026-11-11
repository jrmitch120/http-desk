// Builds an editor document from a body's UTF-8 bytes in pieces, so a large
// body never blocks the main thread for long: each piece is decoded with a
// streaming TextDecoder (a character split between pieces comes out whole),
// split into lines (a `\r\n` split between pieces is one break), and appended
// to a CodeMirror `Text`. The result is the document CodeMirror would make from
// the whole text at once. No Svelte or DOM here: the caller says how to pause.

import { Text } from "@codemirror/state";

/**
 * How many bytes are decoded and appended at a time. Measured on #58: 256 KB
 * pieces took at most 16 ms each, while 1 MB pieces reached 51 ms.
 */
export const PIECE_BYTES = 256 * 1024;

/** A line break as CodeMirror reads one by default. */
const LINE_BREAK = /\r\n?|\n/;

/** The length of each document's longest line, noted as it's built. */
const longest = new WeakMap<Text, number>();

/**
 * The length of `doc`'s longest line: noted when the document was built here,
 * else measured once (going through every line).
 */
export function longestLine(doc: Text): number {
  let n = longest.get(doc);
  if (n === undefined) {
    n = 0;
    for (const lines = doc.iterLines(); !lines.next().done; ) n = Math.max(n, lines.value.length);
    longest.set(doc, n);
  }
  return n;
}

/** A small text as a document, built at once. */
export function textDoc(text: string): Text {
  const lines = text.split(LINE_BREAK);
  const doc = Text.of(lines);
  longest.set(doc, lines.reduce((n, l) => Math.max(n, l.length), 0));
  return doc;
}

export class DocBuilder {
  #decoder = new TextDecoder();
  /** The lines so far, all complete; null until the first line ends. */
  #doc: Text | null = null;
  /** The line still being read (it may continue in the next piece). */
  #line = "";
  /** The longest line so far. */
  #longest = 0;
  /** The last piece ended in `\r`, which is a break whether or not `\n` follows. */
  #cr = false;

  /** Adds the next bytes of the body. */
  push(bytes: Uint8Array): void {
    this.#add(this.#decoder.decode(bytes, { stream: true }));
  }

  /** Adds what's left and returns the whole document. */
  finish(): Text {
    const rest = (this.#cr ? "\r" : "") + this.#decoder.decode();
    this.#cr = false;
    const lines = rest.split(LINE_BREAK);
    lines[0] = this.#line + lines[0];
    this.#line = "";
    this.#append(lines);
    longest.set(this.#doc!, this.#longest);
    return this.#doc!;
  }

  #add(text: string) {
    // A `\r` held back from the last piece goes in front again, so a `\n`
    // starting this one joins it as one break.
    if (this.#cr) text = "\r" + text;
    this.#cr = text.endsWith("\r");
    if (this.#cr) text = text.slice(0, -1);
    // Only this piece is scanned for breaks, so a long line costs no more than
    // a short one.
    const lines = text.split(LINE_BREAK);
    if (lines.length === 1) {
      this.#line += text;
      return;
    }
    lines[0] = this.#line + lines[0];
    this.#line = lines.pop()!;
    this.#append(lines);
  }

  /** Appends `lines`, each after a line break (the first one starts the document). */
  #append(lines: string[]) {
    for (const l of lines) if (l.length > this.#longest) this.#longest = l.length;
    this.#doc = this.#doc ? this.#doc.append(Text.of(["", ...lines])) : Text.of(lines);
  }
}

/**
 * Builds the document for the UTF-8 `bytes`, a piece at a time, awaiting
 * `pause()` between pieces (to give the browser a turn).
 */
export async function buildDoc(bytes: ArrayBuffer, pause: () => Promise<void>): Promise<Text> {
  const b = new DocBuilder();
  for (let at = 0; at < bytes.byteLength; at += PIECE_BYTES) {
    if (at > 0) await pause();
    b.push(new Uint8Array(bytes, at, Math.min(PIECE_BYTES, bytes.byteLength - at)));
  }
  return b.finish();
}
