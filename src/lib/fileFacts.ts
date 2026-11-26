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
