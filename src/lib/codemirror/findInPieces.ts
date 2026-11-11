// Find next and previous, and selecting the next occurrence (Mod-d) or every
// occurrence (Mod-Shift-l) of the selection, worked through the document a
// piece at a time, so a search of a huge body never blocks the window.
// CodeMirror's own commands scan the whole document in one go (seconds on a
// 50 MB body); the generators here make the same choices with CodeMirror's
// search cursors, but yield after each piece of the document.
import {
  findNext,
  getSearchQuery,
  openSearchPanel,
  SearchCursor,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
  type SearchQuery,
} from "@codemirror/search";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type Command, type KeyBinding } from "@codemirror/view";
import { slices } from "../timeSlices";

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

/**
 * Goes through the occurrences of `text` in [from, to] as one SearchCursor
 * would (in order, not overlapping), a piece at a time, telling `each` about
 * every one until it returns true. Returns whether it did.
 */
function* occurrences(state: EditorState, text: string, from: number, to: number, size: number, each: (m: Match) => boolean): Generator<void, boolean, void> {
  // Where the cursor would carry on from: the end of the last occurrence, or the piece's start.
  for (let pos = from; pos < to; ) {
    const end = Math.min(to, pos + size);
    // A piece owns the occurrences that start in it; it looks past its end so they're found whole.
    const cursor = new SearchCursor(state.doc, text, pos, Math.min(to, end + text.length));
    for (cursor.next(); !cursor.done && cursor.value.from < end; cursor.next()) {
      if (each({ from: cursor.value.from, to: cursor.value.to })) return true;
      pos = cursor.value.to;
    }
    pos = Math.max(pos, end);
    if (pos < to) yield;
  }
  return false;
}

/**
 * The occurrence Mod-d (CodeMirror's selectNextOccurrence) adds for a
 * selection of ranges that all hold `text`: the next one after the last range,
 * wrapping round to the start, a whole word if the main selection is one.
 */
export function* nextOccurrence(state: EditorState, text: string, size = PIECE): PieceSearch {
  const { main, ranges } = state.selection;
  const word = state.wordAt(main.head);
  const fullWord = !!word && word.from === main.from && word.to === main.to;
  const isWord = (m: Match) => {
    const w = state.wordAt(m.from);
    return !fullWord || (!!w && w.from === m.from && w.to === m.to);
  };
  const last = ranges[ranges.length - 1];
  let found = null as Match | null;
  if (yield* occurrences(state, text, last.to, state.doc.length, size, (m) => isWord(m) && !!(found = m))) return found;
  yield;
  const taken = (m: Match) => ranges.some((r) => r.from === m.from);
  if (yield* occurrences(state, text, 0, Math.max(0, last.from - 1), size, (m) => !taken(m) && isWord(m) && !!(found = m))) return found;
  return null;
}

/** As CodeMirror's selectSelectionMatches: more occurrences than this select none. */
const MAX_OCCURRENCES = 1000;

/** What Mod-Shift-l selects: every occurrence of the main selection's text, and which is the main one. */
export interface Occurrences {
  ranges: Match[];
  main: number;
}

/**
 * Every occurrence of the (single, non-empty) selection's text, as Mod-Shift-l
 * (CodeMirror's selectSelectionMatches) selects them; null if there are more
 * than it selects.
 */
export function* allOccurrences(state: EditorState, size = PIECE): Generator<void, Occurrences | null, void> {
  const { from, to } = state.selection.main;
  const ranges: Match[] = [];
  let main = 0;
  const tooMany = yield* occurrences(state, state.sliceDoc(from, to), 0, state.doc.length, size, (m) => {
    if (ranges.length > MAX_OCCURRENCES) return true;
    if (m.from === from) main = ranges.length;
    ranges.push({ from: m.from, to: m.to });
    return false;
  });
  return tooMany ? null : { ranges, main };
}

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
 * Runs `search` in slices (timeSlices.ts), letting the window paint and take
 * input in between, then hands what it found to `found` (nothing, if it found
 * nothing). One search runs per view: this abandons the one before.
 */
function run<T>(view: EditorView, search: Generator<void, T | null, void>, found: (result: T) => void): void {
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
  const slice = slices();
  const work = () => {
    if (abandoned) return;
    for (;;) {
      const step = search.next();
      if (step.done) {
        stop();
        if (step.value) found(step.value);
        return;
      }
      if (slice.due()) break;
    }
    setSearching(true);
    void slice.pause().then(work);
  };
  running.set(view, stop);
  // The first slice runs now, so a find in a small document is as immediate as ever.
  work();
}

/** CodeMirror's findNext or findPrevious, in pieces. With no valid query, it opens the find bar instead. */
function finder(direction: "next" | "previous"): Command {
  return (view) => {
    const query = getSearchQuery(view.state);
    if (!query.valid) return openSearchPanel(view);
    const { from, to } = view.state.selection.main;
    const search = direction === "next" ? nextMatch(view.state, query, to) : previousMatch(view.state, query, from);
    run(view, search, (m) => select(view, m));
    return true;
  };
}

/** CodeMirror's selectNextOccurrence (Mod-d), in pieces. An empty selection selects its word, which needs no search. */
export const selectNextOccurrenceInPieces: Command = (view) => {
  const { state } = view;
  const { ranges } = state.selection;
  if (ranges.some((r) => r.empty)) return selectNextOccurrence(view);
  const text = state.sliceDoc(ranges[0].from, ranges[0].to);
  if (ranges.some((r) => state.sliceDoc(r.from, r.to) !== text)) return false;
  run(view, nextOccurrence(state, text), (m) =>
    view.dispatch({
      selection: view.state.selection.addRange(EditorSelection.range(m.from, m.to), false),
      effects: EditorView.scrollIntoView(m.to),
    }),
  );
  return true;
};

/** CodeMirror's selectSelectionMatches (Mod-Shift-l), in pieces. */
export const selectSelectionMatchesInPieces: Command = (view) => {
  const { selection } = view.state;
  if (selection.ranges.length > 1 || selection.main.empty) return false;
  run(view, allOccurrences(view.state), ({ ranges, main }) =>
    view.dispatch({
      selection: EditorSelection.create(ranges.map((m) => EditorSelection.range(m.from, m.to)), main),
      userEvent: "select.search.matches",
    }),
  );
  return true;
};

/** Find next, in pieces. */
export const findNextInPieces: Command = finder("next");
/** Find previous, in pieces. */
export const findPreviousInPieces: Command = finder("previous");

/** searchKeymap's keys that search the document, bound to the searches in pieces. */
const inPieces = new Map<Command | undefined, Partial<KeyBinding>>([
  [findNext, { run: findNextInPieces, shift: findPreviousInPieces }], // F3 and Mod-g, Shift for previous
  [selectNextOccurrence, { run: selectNextOccurrenceInPieces }], // Mod-d
  [selectSelectionMatches, { run: selectSelectionMatchesInPieces }], // Mod-Shift-l
]);
const findKeymap: KeyBinding[] = searchKeymap.filter((b) => inPieces.has(b.run)).map((b) => ({ ...b, ...inPieces.get(b.run) }));

/**
 * Find next and previous, and Mod-d and Mod-Shift-l, in pieces, for an editor
 * with `search()`. Its keys go ahead of searchKeymap's, so it must come before
 * that in the extensions. A change to the document abandons a search, as does
 * destroying the editor.
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
