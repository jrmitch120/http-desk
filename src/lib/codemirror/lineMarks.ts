// A gutter of line markers, each with a hover in the app's tooltip: the Source
// view's portability markers (#170). An Editor given `lineMarks` has it, and
// follows the prop.
import { MapMode, RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { tooltip } from "../popup/tooltip.svelte";

/** A marker on `line` (1-based) with hover `text`; `kind` styles it (`cm-line-mark-<kind>`). */
export interface LineMark {
  line: number;
  kind: string;
  text: string;
}

export const setLineMarks = StateEffect.define<LineMark[]>();

/**
 * The markers: those on the document's lines, at their lines' starts (what the
 * gutter shows), and those past its end (from text not shown yet), as given.
 */
interface Marks {
  set: RangeSet<Marker>;
  beyond: LineMark[];
}

/** `marks` placed in `doc`. */
function place(doc: Text, marks: LineMark[]): Marks {
  const on = marks.filter((m) => m.line >= 1 && m.line <= doc.lines).sort((a, b) => a.line - b.line);
  return { set: RangeSet.of(on.map((m) => new Marker(m).range(doc.line(m.line).from))), beyond: marks.filter((m) => !on.includes(m)) };
}

const marksField = StateField.define<Marks>({
  create: () => ({ set: RangeSet.empty, beyond: [] }),
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setLineMarks)) return place(tr.state.doc, e.value);
    if (!tr.docChanged) return marks;
    // Typed text moves each marker with its line until the next marks arrive. Only
    // those in the text the edit put in can have left their line's start (#168).
    const doc = tr.state.doc;
    let set = marks.set.map(tr.changes);
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const moved: Range<Marker>[] = [];
      set.between(fromB, toB, (from, _to, m) => void (doc.lineAt(from).from !== from && moved.push(m.range(doc.lineAt(from).from))));
      if (moved.length) set = set.update({ filterFrom: fromB, filterTo: toB, filter: (from) => doc.lineAt(from).from === from, add: moved, sort: true });
    });
    const shown = marks.beyond.filter((m) => m.line <= doc.lines);
    if (shown.length) set = set.update({ add: shown.map((m) => new Marker(m).range(doc.line(m.line).from)), sort: true });
    return { set, beyond: shown.length ? marks.beyond.filter((m) => !shown.includes(m)) : marks.beyond };
  },
});

class Marker extends GutterMarker {
  constructor(readonly mark: LineMark) {
    super();
  }
  // Mapped as its line's start is: text put in at the start goes before it, and it's never dropped.
  startSide = 1;
  endSide = 1;
  mapMode = MapMode.Simple;
  eq(other: Marker) {
    return other.mark.kind === this.mark.kind && other.mark.text === this.mark.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-line-mark cm-line-mark-${this.mark.kind}`;
    el.setAttribute("aria-label", this.mark.text);
    tips.set(el, tooltip(el, this.mark.text));
    return el;
  }
  destroy(dom: Node) {
    tips.get(dom)?.destroy();
    tips.delete(dom);
  }
}
const tips = new WeakMap<Node, ReturnType<typeof tooltip>>();

export const lineMarks = (): Extension => [
  marksField,
  gutter({
    class: "cm-line-marks",
    markers: (view) => view.state.field(marksField).set,
  }),
  EditorView.theme({
    ".cm-line-marks .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", width: "12px" },
    ".cm-line-mark": { width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--info)", opacity: "0.75" },
    ".cm-line-mark:hover": { opacity: "1" },
    ".cm-line-mark-httpdesk-only": { backgroundColor: "var(--faint)" },
    ".cm-line-mark-warning": { backgroundColor: "var(--warning)" },
  }),
];

/** The markers in `state` (an editor's with `lineMarks()`), on the lines they're on now. */
export function lineMarksIn(state: EditorState): LineMark[] {
  const marks = state.field(marksField, false);
  if (!marks) return [];
  const out: LineMark[] = [];
  marks.set.between(0, state.doc.length, (from, _to, m) => void out.push({ ...m.mark, line: state.doc.lineAt(from).number }));
  return [...out, ...marks.beyond];
}
