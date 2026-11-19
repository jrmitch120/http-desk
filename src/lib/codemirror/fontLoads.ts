// An editor measures its lines again when a font loads.
//
// CodeMirror measures each line's height as it draws it, and measures them all
// once more when the page's fonts are first ready, but not when a face first
// used later loads. The Source view's comments are the first monospace italic
// text the app shows, so that face loads only after the editor has drawn them in
// a fallback font: on Linux, whose fallback makes those lines taller, CodeMirror
// kept the taller heights, its gutter drifted below the text and a click landed
// on the line above the one clicked.
import { ViewPlugin } from "@codemirror/view";

/**
 * Measures the editor again each time the page finishes loading a font. The
 * lines' new heights change the content's, which makes CodeMirror read them.
 */
export const measureOnFontLoad = ViewPlugin.define((view) => {
  const fonts = view.dom.ownerDocument.fonts;
  const measure = () => view.requestMeasure();
  fonts?.addEventListener("loadingdone", measure);
  return { destroy: () => fonts?.removeEventListener("loadingdone", measure) };
});
