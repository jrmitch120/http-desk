// Each line's own line ending, in an editor showing the text of a file with mixed endings
// (#161: the core keeps such text as written, each `\r` in place). CodeMirror reads `\r\n`,
// `\r` and `\n` all as a line break and gives its text back with `\n`, so on its own it
// would drop every `\r` once edited. This keeps where the text's breaks aren't the
// file's own ending (most lines', `newBreak`), follows them through edits, and writes them
// back: a break typed anew gets the file's ending; one deleted is gone. A lone `\r` (a
// break of its own, as old Mac files have) comes back as the file's ending.
import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension } from "@codemirror/state";

export type LineBreak = "\n" | "\r\n";

/**
 * `text` as CodeMirror holds it (each break one `\n`, `\r\n` read as one), and the offsets
 * in that of the breaks that aren't `newBreak`, in order.
 */
export function readEndings(text: string, newBreak: LineBreak): { doc: string; others: number[] } {
  const others: number[] = [];
  let doc = "";
  let at = 0;
  for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", nl + 1)) {
    const crlf = nl > 0 && text[nl - 1] === "\r";
    doc += ownBreaks(text.slice(at, crlf ? nl - 1 : nl));
    if ((crlf ? "\r\n" : "\n") !== newBreak) others.push(doc.length);
    doc += "\n";
    at = nl + 1;
  }
  return { doc: doc + ownBreaks(text.slice(at)), others };
}

/**
 * A lone `\r` within a line is a break of its own to CodeMirror: `\n` here, one
 * character as it was, so every offset after it is the same in the editor (left as
 * `\r`, one before a `\r\n` would be read with it as a single break).
 */
const ownBreaks = (line: string) => (line.includes("\r") ? line.replaceAll("\r", "\n") : line);

/**
 * `ranges`, offsets into `text` (which keeps each line's own ending), as offsets into
 * the document CodeMirror holds for it (`readEndings`), where every break is one
 * character: each `\r\n` before an offset is one character less.
 */
export function inDocument<T extends { from: number; to: number }>(text: string, ranges: T[]): T[] {
  if (!ranges.length || !text.includes("\r\n")) return ranges;
  const crlfs: number[] = [];
  for (let i = text.indexOf("\r\n"); i >= 0; i = text.indexOf("\r\n", i + 2)) crlfs.push(i);
  // How many `\r\n` start before `offset`.
  const before = (offset: number) => {
    let lo = 0;
    let hi = crlfs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crlfs[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return ranges.map((r) => ({ ...r, from: r.from - before(r.from), to: r.to - before(r.to) }));
}

/** `doc` (CodeMirror's text, `\n` breaks) written with `newBreak`, except at `others`, the offsets of breaks that have the other ending. */
export function writeEndings(doc: string, others: readonly number[], newBreak: LineBreak): string {
  const other = newBreak === "\n" ? "\r\n" : "\n";
  let out = "";
  let at = 0;
  let o = 0;
  for (let nl = doc.indexOf("\n"); nl >= 0; nl = doc.indexOf("\n", nl + 1)) {
    while (o < others.length && others[o] < nl) o++;
    out += doc.slice(at, nl) + (others[o] === nl ? other : newBreak);
    at = nl + 1;
  }
  return out + doc.slice(at);
}

/** `others` (offsets of breaks) after `changes`: a break deleted or replaced is gone, the rest move with the text. */
export function mapEndings(others: readonly number[], changes: ChangeSet): number[] {
  const out: number[] = [];
  for (const p of others) {
    let gone = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= p && toA > p) gone = true;
    });
    if (!gone) out.push(changes.mapPos(p, 1));
  }
  return out;
}

/** Puts in a new text's breaks with the other ending (`readEndings`), with the text that has them. */
export const setEndings = StateEffect.define<number[]>();

/** Where an editor's breaks have the other ending. */
export const endingsField = StateField.define<number[]>({
  create: () => [],
  update(others, tr) {
    for (const e of tr.effects) if (e.is(setEndings)) return e.value;
    return tr.docChanged && others.length ? mapEndings(others, tr.changes) : others;
  },
});

/** Keeps each line's ending (`endingsField`), starting with `others`. */
export function keepLineEndings(others: number[] = []): Extension {
  return endingsField.init(() => others);
}

/** `state`'s text, each line with its own ending and new ones `newBreak`. */
export function textWithEndings(state: EditorState, newBreak: LineBreak): string {
  return writeEndings(state.doc.toString(), state.field(endingsField, false) ?? [], newBreak);
}
