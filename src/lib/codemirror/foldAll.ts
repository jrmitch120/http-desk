// Fold all without freezing the window (#115). Folding needs the whole syntax
// tree, and a full parse costs about 125 ms per MB, so the parse runs in short
// slices across tasks before CodeMirror's `foldAll` folds.
//
// It also runs in stages of STAGE_CHARS. Lezer builds a parse's finished tree
// in one go when the parse ends, which costs about 3.5 ms per MB of document
// parsed (7 ms on CI): parsed whole, an 8 MB body's last slice took 66–71 ms on
// CI. Each stage instead ends a parse a little further on, and the next one
// reuses the tree so far (Lezer reuses whole subtrees of earlier parses), so a
// stage's tree costs about what its new text does, whatever the document's size.
import { ensureSyntaxTree, foldAll, forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { nextTask, SLICE_MS } from "../timeSlices";

/**
 * The longest document (in characters, about bytes for JSON and XML) Fold all
 * works on, set by the spec's rule (#58): the largest whole number of MB of
 * Pretty text at which the perf test's Fold all step (6b) stays under 50 ms,
 * here capped just under the perf test's 50 MB body (87.9 MB of Pretty text),
 * which Fold all is to stay off for (step 6).
 *
 * Measured on 2026-11-10 on a quiet M1 Pro, with Chromium's CPU throttled 2×
 * (PERF_CPU_THROTTLE=2) to match CI's ubuntu-22.04 runner: before parsing in
 * stages, step 6b at 8 MB took 66–71 ms on CI and 69–72 ms throttled 2×
 * (34–41 ms unthrottled). With stages, the longest task while folding (traced)
 * was 19–20 ms at 8, 16 and 32 MB and 20–26 ms at 87 MB (5 of 5 runs, Fold all
 * taking about 25 s throttled, 11 s not): it no longer grows with the size, so
 * the rule allows every size the perf body leaves room for. Step 6b at 87 MB
 * passed 5 of 5 runs throttled. Re-measure with step 6b and PERF_CPU_THROTTLE
 * if the parser or slicing changes.
 */
export const FOLD_ALL_LIMIT = 87 * 1000 * 1000;

/** Whether Fold all works on a document `length` characters long. */
export function canFoldAll(length: number): boolean {
  return length <= FOLD_ALL_LIMIT;
}

/** How far each stage of the parse reaches past the last: its finished tree takes 1–4 ms to build. */
const STAGE_CHARS = 256 * 1024;

/**
 * Parses `view`'s document in slices and stages, yielding between them, then
 * folds every top-level block. Gives up (resolving false) if `cancelled()`
 * turns true, the document changes or the view goes away meanwhile.
 */
export async function foldAllInPieces(view: EditorView, cancelled: () => boolean = () => false): Promise<boolean> {
  const doc = view.state.doc;
  const stale = () => cancelled() || view.state.doc !== doc || !view.dom.isConnected;
  for (let upto = 0; upto < doc.length; ) {
    upto = Math.min(doc.length, upto + STAGE_CHARS);
    for (;;) {
      if (stale()) return false;
      if (ensureSyntaxTree(view.state, upto, SLICE_MS)) break;
      await nextTask();
    }
  }
  // The whole tree reaches the view, and then the view folds, each in a task of its own.
  await nextTask();
  if (stale()) return false;
  forceParsing(view, doc.length);
  await nextTask();
  if (stale()) return false;
  foldAll(view);
  return true;
}
