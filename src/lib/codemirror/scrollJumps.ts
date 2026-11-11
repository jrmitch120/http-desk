// Jumping far into a very tall document (dragging the scroll bar of a large
// body's Pretty text) in one pass of CodeMirror's measuring, not five (#58).
//
// CodeMirror draws a document taller than MAX_DOM_HEIGHT scaled down to that
// height, except for the part it has drawn (its viewport), which keeps its real
// height. So where a scroll position lands in the document depends on where the
// viewport is. After a jump, CodeMirror reads the new position as the old
// viewport places it, draws a viewport there, and reads the position again,
// which the new viewport has moved by about the old one's height scaled up
// (some 18,000 px of an 88 MB body): outside what it just drew. It goes round
// up to five times ("Viewport failed to stabilize"), redrawing and laying out
// the editor each time: 40–55 ms in one task on CI.
//
// So a scroll that lands outside the drawn viewport of such a document scrolls
// to the line found there instead, at once. CodeMirror then draws the viewport
// around that line and puts the line at the top, which settles in one pass.

import { EditorView } from "@codemirror/view";

/**
 * The tallest document CodeMirror draws at its real height (its internal
 * `VP.MaxDOMHeight`). A taller one is drawn this tall, give or take a pixel of
 * rounding, so anything within 1% of it is taken to be scaled.
 */
const MAX_DOM_HEIGHT = 7_000_000;

/** Whether `view` draws its document scaled down. */
function scaled(view: EditorView): boolean {
  const { top, bottom } = view.documentPadding;
  return view.contentHeight - top - bottom >= MAX_DOM_HEIGHT * 0.99;
}

/**
 * The start of the line at `height` (from the top of the document, as drawn).
 * `view.lineBlockAtHeight` would make the view measure first, the very pass
 * this avoids, so this searches the lines with `lineBlockAt`, which doesn't.
 */
function lineAtHeight(view: EditorView, height: number): number {
  const { doc } = view.state;
  let lo = 1;
  let hi = doc.lines;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (view.lineBlockAt(doc.line(mid).from).top <= height) lo = mid;
    else hi = mid - 1;
  }
  return doc.line(lo).from;
}

/** Turns a scroll far into a scaled document into a scroll to the line there. */
export const scrollJumps = EditorView.domEventHandlers({
  scroll(_e, view) {
    if (!scaled(view)) return false;
    const scroller = view.scrollDOM;
    const top = scroller.getBoundingClientRect().top - view.documentTop;
    const { from, to } = view.viewport;
    if (top >= view.lineBlockAt(from).top && top <= view.lineBlockAt(to).bottom) return false;
    // At the very end, the end, so the last line shows whatever the scaling.
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const effect = atEnd
      ? EditorView.scrollIntoView(view.state.doc.length, { y: "end", yMargin: 0 })
      : EditorView.scrollIntoView(lineAtHeight(view, top), { y: "start", yMargin: 0 });
    view.dispatch({ effects: effect });
    return false;
  },
});
