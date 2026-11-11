// Find next and previous, worked through the document a piece at a time, so a
// search of a huge body never blocks the window. CodeMirror's own findNext and
// findPrevious scan the whole document in one go (seconds on a 50 MB body); the
// generators here make the same choices with CodeMirror's search cursors, but
// yield after each piece of the document.
import { findNext, getSearchQuery, openSearchPanel, searchKeymap, type SearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type Command, type KeyBinding } from "@codemirror/view";

/** A match's range in the document. */
export interface Match {
  from: number;
  to: number;
}

/** About how many characters each piece searches (a few milliseconds' work). */
export const PIECE = 32_768;
/** How far past its piece a regular expression's match may reach and still be found whole. */
const REGEXP_REACH = 1024;

/** A search that yields after each piece and returns the match it settles on, or null. */
export type PieceSearch = Generator<void, Match | null, void>;

/**
 * Where the piece starting at `start` ends, going towards `end`. A regular
 * expression's pieces end at a line break where they can (lines are what its
 * cursor matches in), so `^` and lookbehinds see whole lines; a line too long
 * for that is split anyway.
 */
function pieceEnd(state: EditorState, query: SearchQuery, start: number, end: number, size: number): number {
  const at = start + size;
  if (at >= end) return end;
  if (query.regexp) {
    const line = state.doc.lineAt(at).from;
    if (line > start) return line;
  }
  return at;
}

/** Where the piece ending at `end` starts, going back towards `start` (see `pieceEnd`). */
function pieceStart(state: EditorState, query: SearchQuery, start: number, end: number, size: number): number {
  const at = end - size;
  if (at <= start) return start;
  if (query.regexp) {
    const line = state.doc.lineAt(at).from;
    if (line > start && end - line <= 4 * size) return line;
  }
  return at;
}

/** How far a match may reach past the piece it starts in. */
function reach(query: SearchQuery): number {
  // Lower-casing can lengthen a few characters, hence the slack.
  return query.regexp ? REGEXP_REACH : 2 * query.search.length + 16;
}

/**
 * The matches in [from, to], one at a time. A string query's cursor reports
 * overlapping matches too, as CodeMirror's findNext and findPrevious see them.
 */
function* matchesIn(state: EditorState, query: SearchQuery, from: number, to: number): Generator<Match> {
  const cursor = query.getCursor(state, from, to) as Iterator<Match> & { nextOverlapping?(): IteratorResult<Match> };
  const step = query.regexp || !cursor.nextOverlapping ? () => cursor.next() : () => cursor.nextOverlapping!();
  for (let r = step(); !r.done; r = step()) yield { from: r.value.from, to: r.value.to };
}

/** The first match in [from, to], searched a piece at a time from the start. */
function* firstIn(state: EditorState, query: SearchQuery, from: number, to: number, size: number): PieceSearch {
  for (let start = from; ; ) {
    const end = pieceEnd(state, query, start, to, size);
    // A piece owns the matches that start in it; it looks past its end so they're found whole.
    const first = matchesIn(state, query, start, Math.min(to, end + reach(query))).next();
    if (!first.done && (first.value.from < end || end === to)) return first.value;
    if (end === to) return null;
    start = end;
    yield;
  }
}

/** The last match in [from, to], searched a piece at a time from the end. */
function* lastIn(state: EditorState, query: SearchQuery, from: number, to: number, size: number): PieceSearch {
  for (let end = to; ; ) {
    const start = pieceStart(state, query, from, end, size);
    let last: Match | null = null;
    for (const m of matchesIn(state, query, start, Math.min(to, end + reach(query))))
      if (m.from < end || end === to) last = m;
      else break;
    if (last || start === from) return last;
    end = start;
    yield;
  }
}

/**
 * The match Find next moves to from `pos` (the end of the selection): the
 * first one after it, wrapping round to the start of the document.
 */
export function* nextMatch(state: EditorState, query: SearchQuery, pos: number, size = PIECE): PieceSearch {
  const length = state.doc.length;
  let found = yield* firstIn(state, query, pos, length, size);
  if (!found) {
    yield;
    found = yield* firstIn(state, query, 0, query.regexp ? pos : Math.min(length, pos + query.search.length), size);
  }
  return found && !(found.from === pos && found.to === pos) ? found : null;
}

/**
 * The match Find previous moves to from `pos` (the start of the selection):
 * the last one before it, wrapping round to the end of the document.
 */
export function* previousMatch(state: EditorState, query: SearchQuery, pos: number, size = PIECE): PieceSearch {
  const length = state.doc.length;
  let found = yield* lastIn(state, query, 0, pos, size);
  if (!found) {
    yield;
    found = yield* lastIn(state, query, query.regexp ? pos : Math.max(0, pos - query.search.length), length, size);
  }
  return found && !(found.from === pos && found.to === pos) ? found : null;
}

/** How long a search works before letting the window paint and take input. */
const SLICE_MS = 12;

/** Each view's search in progress (what abandons it), and who's told when one starts or stops running. */
const running = new WeakMap<EditorView, () => void>();
const watchers = new WeakMap<EditorView, (searching: boolean) => void>();

/** Tells `watch` whenever a search in `view` starts or stops running in pieces (the find bar's "Searching…"). */
export function watchSearching(view: EditorView, watch: (searching: boolean) => void): () => void {
  watchers.set(view, watch);
  return () => {
    if (watchers.get(view) === watch) watchers.delete(view);
  };
}

/** Stops the search in progress in `view`, if any. Safe while the view is updating. */
export function abandonSearch(view: EditorView): void {
  running.get(view)?.();
}

/** Moves the selection to `m` and scrolls to it, as CodeMirror's findNext does. */
function select(view: EditorView, m: Match): void {
  const selection = EditorSelection.single(m.from, m.to);
  const phrase = (p: string) => view.state.phrase(p);
  const text = view.state.sliceDoc(m.from, Math.min(m.to, m.from + 100));
  view.dispatch({
    selection,
    effects: [
      EditorView.announce.of(`${phrase("current match")}. ${text} ${phrase("on line")} ${view.state.doc.lineAt(m.from).number}.`),
      EditorView.scrollIntoView(selection.main),
    ],
    userEvent: "select.search",
  });
  // As with CodeMirror's: typing in the Find field after a find replaces the query.
  const field = view.dom.querySelector<HTMLInputElement>(".cm-panels [main-field]");
  if (field && field === view.root.activeElement) field.select();
}

/**
 * Runs `search` in slices of a few milliseconds, letting the window paint and
 * take input in between, then selects what it found. One search runs per
 * view: this abandons the one before.
 */
function run(view: EditorView, search: PieceSearch): void {
  abandonSearch(view);
  let abandoned = false;
  let searching = false;
  const setSearching = (on: boolean) => {
    if (on === searching) return;
    searching = on;
    watchers.get(view)?.(on);
  };
  const stop = () => {
    abandoned = true;
    if (running.get(view) === stop) running.delete(view);
    setSearching(false);
  };
  const slice = () => {
    if (abandoned) return;
    const until = performance.now() + SLICE_MS;
    for (;;) {
      const step = search.next();
      if (step.done) {
        stop();
        if (step.value) select(view, step.value);
        return;
      }
      if (performance.now() >= until) break;
    }
    setSearching(true);
    setTimeout(slice);
  };
  running.set(view, stop);
  // The first slice runs now, so a find in a small document is as immediate as ever.
  slice();
}

/** CodeMirror's findNext or findPrevious, in pieces. With no valid query, it opens the find bar instead. */
function finder(direction: "next" | "previous"): Command {
  return (view) => {
    const query = getSearchQuery(view.state);
    if (!query.valid) return openSearchPanel(view);
    const { from, to } = view.state.selection.main;
    run(view, direction === "next" ? nextMatch(view.state, query, to) : previousMatch(view.state, query, from));
    return true;
  };
}

/** Find next, in pieces. */
export const findNextInPieces: Command = finder("next");
/** Find previous, in pieces. */
export const findPreviousInPieces: Command = finder("previous");

/** searchKeymap's find next and previous keys (F3 and Mod-g, Shift for previous), bound to the searches in pieces. */
const findKeymap: KeyBinding[] = searchKeymap.filter((b) => b.run === findNext).map((b) => ({ ...b, run: findNextInPieces, shift: findPreviousInPieces }));

/**
 * Find next and previous in pieces, for an editor with `search()`. Its keys
 * go ahead of searchKeymap's, so it must come before that in the extensions.
 * A change to the document abandons a search, as does destroying the editor.
 */
export const findInPieces: Extension = [
  keymap.of(findKeymap),
  ViewPlugin.define((view) => ({
    update: (u) => {
      if (u.docChanged) abandonSearch(view);
    },
    destroy: () => abandonSearch(view),
  })),
];
