import type { HttpFile, LineEnding } from "./types";

/** One fact about a file as the bottom bar's left group shows it: a short label, and a tooltip saying what HttpDesk does about it. */
export interface FileFact {
  label: string;
  tooltip: string;
}

const ENDING: Record<LineEnding, string> = { lf: "LF", crlf: "CRLF" };

/**
 * A `.http` file's line endings ("LF", "CRLF" or "Mixed") and encoding ("UTF-8" or
 * "UTF-8 BOM"), from the facts the core read it with. HttpDesk keeps both as the file
 * has them (a mixed file, each line's own ending), so the tooltips say so.
 */
export function fileFacts(file: Pick<HttpFile, "lineEnding" | "mixedEndings" | "bom">): { endings: FileFact; encoding: FileFact } {
  const ending = ENDING[file.lineEnding];
  const endings = file.mixedEndings
    ? { label: "Mixed", tooltip: `Line endings: mixed CRLF and LF. HttpDesk keeps each line's own ending; a new line gets ${ending}, the file's most common.` }
    : { label: ending, tooltip: `Line endings: ${ending}. HttpDesk keeps them as the file has them.` };
  const encoding = file.bom
    ? { label: "UTF-8 BOM", tooltip: "Encoding: UTF-8, starting with a byte order mark (BOM). HttpDesk keeps the BOM on save." }
    : { label: "UTF-8", tooltip: "Encoding: UTF-8, without a byte order mark (BOM). HttpDesk saves it without one." };
  return { endings, encoding };
}

/**
 * Where the caret is in a File view, as "Ln l, Col c" (1-based): `line` is the caret's
 * line (its number and text), `offset` the caret's place in it in UTF-16 units, as the
 * editor counts. The column counts characters, so a line with an emoji reads as other
 * editors read it.
 */
export function caretFact(line: { number: number; text: string }, offset: number): FileFact {
  const column = [...line.text.slice(0, offset)].length + 1;
  return { label: `Ln ${line.number}, Col ${column}`, tooltip: `The caret: line ${line.number}, column ${column}. Columns count characters.` };
}
