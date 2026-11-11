// Which documents may be shown unwrapped (#119). Unwrapped, CodeMirror draws
// only part of a long line and stands in for the rest with "line gaps" as wide
// as the text they replace, up to VP.MaxHorizGap (2,000,000 px) each in
// @codemirror/view. A wider gap is drawn at that width, and scrolling across
// such a line goes wrong: the scroll range covers only a small part of it,
// and at its far right the editor shows nothing (a 50 MB minified body is
// about 390 million px wide). Such a line can't usefully be read by scrolling
// sideways anyway, so a document with one is always shown wrapped instead.
import type { Text } from "@codemirror/state";
import { longestLine } from "./docBuilder";

/**
 * The longest line (in characters) a document may have and still be shown
 * unwrapped. CodeMirror sizes a gap by its characters times the editor's
 * character width: 7.5 px for the body editors' JetBrains Mono at 12.5 px, so
 * no gap reaches VP.MaxHorizGap below about 266,000 characters (measured on
 * #119: scrolled right in steps, a 250,000-character line shows its end and a
 * 300,000-character one shows nothing). This leaves room for a wider fallback
 * font (up to 10 px). The interface's zoom doesn't change it: the whole webview
 * zooms, so the width in CSS px stays the same.
 */
export const UNWRAP_LIMIT = 200_000;

/** Whether `doc` may be shown unwrapped: none of its lines is longer than UNWRAP_LIMIT. */
export function canUnwrap(doc: Text): boolean {
  return longestLine(doc) <= UNWRAP_LIMIT;
}
