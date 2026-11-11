// Fold all without freezing the window (#115). Folding needs the whole syntax
// tree, and a full parse costs about 180 ms per MB, so the parse runs in short
// slices across tasks before CodeMirror's `foldAll` folds. The last slice still
// builds the finished tree in one go, which grows with the document, so Fold all
// is turned off above a measured size.
import { foldAll, forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

/**
 * The longest document (in characters, about bytes for JSON and XML) Fold all
 * works on: the largest whole number of MB of Pretty text at which the folding
 * step stays under 50 ms, taken conservatively.
 *
 * Measured on 2026-11-10 (MacBook, Chromium via Playwright, with other builds
 * and tests running: load average 12–40, so on a quiet machine it may be higher)
 * by timing Fold all with the perf test's long-task observer on the perf
 * fixture's Pretty JSON (`__mock.preparePerf(jsonBytes)`) at 1, 2, 3, 4, 5, 6,
 * 7, 8, 9, 10, 11, 12, 14 and 16 MB, 2 to 6 runs each. The longest task is the
 * last parse slice, which builds the whole tree; `foldAll` itself took 2–6 ms.
 * With 10 ms slices it was 28–37 ms at 7 MB, 33–43 ms at 8 MB, 38–47 ms at 9 MB
 * (no long task in any run up to 9 MB), 50–53 ms at 10 MB and 51–63 ms at 12 MB.
 * 9 MB passed with under 3 ms to spare, so the limit is 8 MB. Re-measure with a
 * copy of perf step "6b" at increasing sizes if the parser or slicing changes.
 */
export const FOLD_ALL_LIMIT = 8 * 1000 * 1000;

/** Whether Fold all works on a document `length` characters long. */
export function canFoldAll(length: number): boolean {
  return length <= FOLD_ALL_LIMIT;
}

/**
 * How long each parse slice may run. Short, as the last slice also builds the
 * finished tree: 20 ms slices put that slice about 6 ms higher, and the limit lower.
 */
const SLICE_MS = 10;

/**
 * Parses `view`'s document in slices, yielding between them, then folds every
 * top-level block. Gives up (resolving false) if `cancelled()` turns true, the
 * document changes or the view goes away meanwhile.
 */
export async function foldAllInPieces(view: EditorView, cancelled: () => boolean = () => false): Promise<boolean> {
  const doc = view.state.doc;
  const stale = () => cancelled() || view.state.doc !== doc || !view.dom.isConnected;
  for (;;) {
    if (stale()) return false;
    if (forceParsing(view, doc.length, SLICE_MS)) break;
    await new Promise((r) => setTimeout(r));
  }
  if (stale()) return false;
  foldAll(view);
  return true;
}
