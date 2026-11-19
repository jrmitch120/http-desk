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
    const line = text.slice(at, crlf ? nl - 1 : nl);
    doc += line;
    if ((crlf ? "\r\n" : "\n") !== newBreak) others.push(doc.length);
    doc += "\n";
    at = nl + 1;
  }
  return { doc: doc + text.slice(at), others };
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
