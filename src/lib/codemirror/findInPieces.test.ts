import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { SearchQuery, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { allOccurrences, nextMatch, nextOccurrence, previousMatch } from "./findInPieces";

/** Runs a search to the end, counting the pieces it took. */
function drain<T>(search: Generator<unknown, T>): { result: T; pieces: number } {
  let pieces = 1;
  for (;;) {
    const r = search.next();
    if (r.done) return { result: r.value, pieces };
    pieces++;
  }
}

const doc = (text: string) => EditorState.create({ doc: text });
const q = (search: string, opts: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) => new SearchQuery({ search, ...opts });

describe("nextMatch", () => {
  it("finds the first match after the position", () => {
    expect(drain(nextMatch(doc("cat dog cat dog"), q("dog"), 5)).result).toEqual({ from: 12, to: 15 });
  });

  it("wraps round to the start when nothing follows the position", () => {
    expect(drain(nextMatch(doc("cat dog cat"), q("dog"), 7)).result).toEqual({ from: 4, to: 7 });
  });

  it("returns null when nothing matches", () => {
    expect(drain(nextMatch(doc("cat dog cat"), q("cow"), 3)).result).toBeNull();
  });

  it("works through a long document in pieces, and still finds a match that straddles two", () => {
    // 10-character pieces: "needle" at 27 starts in the third piece and ends in the fourth.
    const { result, pieces } = drain(nextMatch(doc(`${"x".repeat(27)}needle${"x".repeat(40)}`), q("needle"), 0, 10));
    expect(result).toEqual({ from: 27, to: 33 });
    expect(pieces).toBe(3);
  });

  it("goes through every piece, then wraps, when nothing matches", () => {
    const { result, pieces } = drain(nextMatch(doc("x".repeat(100)), q("needle"), 50, 10));
    expect(result).toBeNull();
    // 50 → 100 is five pieces, 0 → 56 (the start, up to where a match at 50 would end) six.
    expect(pieces).toBe(11);
  });

  it("follows the case, whole-word and regular-expression options", () => {
    const text = "Cat cat category CAT";
    expect(drain(nextMatch(doc(text), q("CAT", { caseSensitive: true }), 0)).result).toEqual({ from: 17, to: 20 });
    expect(drain(nextMatch(doc(text), q("cat", { wholeWord: true }), 5)).result).toEqual({ from: 17, to: 20 });
    expect(drain(nextMatch(doc(text), q("c\\w+y", { regexp: true }), 0)).result).toEqual({ from: 8, to: 16 });
  });

  it("matches a regular expression's line anchors only at line starts, whatever the pieces", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `item ${i} done`).join("\n");
    const state = doc(lines);
    const line12 = state.doc.line(13).from; // "item 12 done"
    expect(drain(nextMatch(state, q("^item 12", { regexp: true }), 0, 7)).result).toEqual({ from: line12, to: line12 + 7 });
    expect(drain(nextMatch(state, q("^tem", { regexp: true }), 0, 7)).result).toBeNull();
  });
});

describe("previousMatch", () => {
  it("finds the last match before the position", () => {
    expect(drain(previousMatch(doc("cat dog cat dog"), q("cat"), 12)).result).toEqual({ from: 8, to: 11 });
  });

  it("wraps round to the end when nothing comes before the position", () => {
    expect(drain(previousMatch(doc("cat dog cat"), q("cat"), 0)).result).toEqual({ from: 8, to: 11 });
  });

  it("works back through a long document in pieces", () => {
    const { result, pieces } = drain(previousMatch(doc(`${"x".repeat(15)}needle${"x".repeat(80)}`), q("needle"), 101, 10));
    expect(result).toEqual({ from: 15, to: 21 });
    expect(pieces).toBe(9);
  });

  it("returns null when nothing matches", () => {
    expect(drain(previousMatch(doc("x".repeat(100)), q("needle"), 50, 10)).result).toBeNull();
  });
});

/** What CodeMirror's own `command` selects in `state`, or null if it does nothing. */
function cmSelects(state: EditorState, command: StateCommand): { from: number; to: number }[] | null {
  let next: EditorState | null = null;
  command({ state, dispatch: (tr) => (next = tr.state) });
  return next ? (next as EditorState).selection.ranges.map((r) => ({ from: r.from, to: r.to })) : null;
}

const withSelection = (text: string, ranges: [number, number][]) =>
  EditorState.create({
    doc: text,
    selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
    extensions: EditorState.allowMultipleSelections.of(true),
  });

describe("nextOccurrence (Mod-d)", () => {
  const cases: [string, [number, number][]][] = [
    ["cat dog cat dog cat", [[0, 3]]],
    ["cat dog cat dog cat", [[0, 3], [8, 11]]],
    ["cat dog cat dog cat", [[16, 19]]], // wraps round
    ["concat cat scatter cat", [[7, 10]]], // a whole word finds whole words only
    ["aaaaaaa", [[0, 2]]], // occurrences don't overlap
    ["at cat at", [[4, 6]]], // part of a word finds parts too
    ["only one here", [[5, 8]]],
  ];
  it("adds what CodeMirror's selectNextOccurrence adds, whatever the pieces", () => {
    for (const [text, ranges] of cases) {
      const state = withSelection(text, ranges);
      const expected = cmSelects(state, selectNextOccurrence);
      const sel = state.selection.ranges;
      for (const size of [1, 2, 3, 7, 100]) {
        const found = drain(nextOccurrence(state, state.sliceDoc(sel[0].from, sel[0].to), size)).result;
        const added = found && state.selection.addRange(EditorSelection.range(found.from, found.to), false);
        const got = added ? added.ranges.map((r) => ({ from: r.from, to: r.to })) : null;
        expect(got, `${text} ${JSON.stringify(ranges)} in ${size}-character pieces`).toEqual(expected);
      }
    }
  });
});

describe("allOccurrences (Mod-Shift-l)", () => {
  it("selects what CodeMirror's selectSelectionMatches selects, whatever the pieces", () => {
    const cases: [string, [number, number]][] = [
      ["cat dog cat dog cat", [8, 11]],
      ["aaaaaaa", [2, 4]],
      ["xx needle xx needle", [3, 9]],
    ];
    for (const [text, sel] of cases) {
      const state = withSelection(text, [sel]);
      const expected = cmSelects(state, selectSelectionMatches);
      for (const size of [1, 2, 3, 100]) {
        const got = drain(allOccurrences(state, size)).result;
        expect(got && got.ranges, `${text} in ${size}-character pieces`).toEqual(expected);
        if (got) expect(got.ranges[got.main].from).toBe(state.selection.main.from);
      }
    }
  });

  it("selects none past CodeMirror's 1000", () => {
    const state = withSelection("ab ".repeat(1200), [[0, 2]]);
    expect(cmSelects(state, selectSelectionMatches)).toBeNull();
    expect(drain(allOccurrences(state, 50)).result).toBeNull();
  });
});
