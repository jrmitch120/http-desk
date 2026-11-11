// How CodeMirror copes with a body's long lines, wrapped and unwrapped. In
// both, it draws only part of a long line and stands in for the rest with
// "line gaps" (`ensureLineGaps` in @codemirror/view), sized by estimate from
// the line's characters. The limits here mirror its internal constants.
import type { Text } from "@codemirror/state";
import { longestLine } from "./docBuilder";

/**
 * The shortest line CodeMirror draws only in part when wrapped: twice its
 * `LG.MarginWrap` (10,000 characters). Its gaps then stand for the rest as
 * full rows of text, so such a line breaks at any character (BodyPanel's
 * `.long-lines`): broken at punctuation, a row holds less than estimated, the
 * line grows as it's scrolled and its end can't be reached.
 */
export const LONG_LINE = 20_000;

/** Whether `doc` has a line CodeMirror draws only in part when wrapped (LONG_LINE). */
export function hasLongLines(doc: Text): boolean {
  return longestLine(doc) >= LONG_LINE;
}

/**
 * The longest line (in characters) a document may have and still be shown
 * unwrapped (#119). Unwrapped, CodeMirror draws no gap wider than
 * `VP.MaxHorizGap` (2,000,000 px); a line wider than that can't be scrolled
 * across: the scroll range covers only a small part of it, and at its far
 * right nothing shows (a 50 MB minified body is about 390 million px wide).
 * Such a line can't usefully be read by scrolling sideways anyway, so a
 * document with one is always shown wrapped instead.
 *
 * CodeMirror sizes a gap by its characters times the editor's character width:
 * 7.5 px for the body editors' JetBrains Mono at 12.5 px, so no gap reaches the
 * cap below about 266,000 characters (measured on #119: scrolled right in
 * steps, a 250,000-character line shows its end and a 300,000-character one
 * shows nothing). This leaves room for a wider fallback font (up to 10 px).
 * The interface's zoom doesn't change it: the whole webview zooms, so the
 * width in CSS px stays the same.
 */
export const UNWRAP_LIMIT = 200_000;

/** Whether `doc` may be shown unwrapped: none of its lines is longer than UNWRAP_LIMIT. */
export function canUnwrap(doc: Text): boolean {
  return longestLine(doc) <= UNWRAP_LIMIT;
}
