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
 * works on: 10 MB, chosen by how long "Folding…" runs, not by the main thread.
 *
 * The spec's rule (#58) was the largest whole number of MB at which the perf
 * test's Fold all step (6b) stays under 50 ms. Since the parse runs in stages,
 * no size reaches that: measured on 2026-11-10 on a quiet M1 Pro, with
 * Chromium's CPU throttled 2× (PERF_CPU_THROTTLE=2) to match CI's
 * ubuntu-22.04 runner, the longest task while folding was 19–26 ms at 8, 16,
 * 32 and 87 MB. But the parse still takes its time: Fold all on 87 MB took
 * about 11 s (25 s throttled), about 125 ms per MB (about 290 ms throttled). So
 * the limit caps the wait instead, at about 1.3 s here and 3 s on CI-speed
 * hardware. Above it, a huge body is usually one top-level array that Fold all
 * would fold to a line anyway, and the tooltip points to the JSONPath filter.
 */
export const FOLD_ALL_LIMIT = 10 * 1000 * 1000;

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
