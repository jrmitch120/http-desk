// A gutter of line markers, each with a hover in the app's tooltip: the Source
// view's portability markers (#170). An Editor given `lineMarks` has it, and
// follows the prop.
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { tooltip } from "../popup/tooltip.svelte";

/** A marker on `line` (1-based) with hover `text`; `kind` styles it (`cm-line-mark-<kind>`). */
export interface LineMark {
  line: number;
  kind: string;
  text: string;
}

export const setLineMarks = StateEffect.define<LineMark[]>();

const marksField = StateField.define<LineMark[]>({
  create: () => [],
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setLineMarks)) return e.value;
    return marks;
  },
});

class Marker extends GutterMarker {
  constructor(readonly mark: LineMark) {
    super();
  }
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

/** The markers on `doc`'s lines, in order; marks past its end (from text not shown yet) are left out. */
function markers(doc: Text, marks: LineMark[]): RangeSet<GutterMarker> {
  const sorted = marks.filter((m) => m.line >= 1 && m.line <= doc.lines).sort((a, b) => a.line - b.line);
  return RangeSet.of(sorted.map((m) => new Marker(m).range(doc.line(m.line).from)));
}

export const lineMarks = (): Extension => [
  marksField,
  gutter({
    class: "cm-line-marks",
    markers: (view) => markers(view.state.doc, view.state.field(marksField)),
  }),
  EditorView.theme({
    ".cm-line-marks .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", width: "12px" },
    ".cm-line-mark": { width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--info)", opacity: "0.75" },
    ".cm-line-mark:hover": { opacity: "1" },
    ".cm-line-mark-httpdesk-only": { backgroundColor: "var(--faint)" },
    ".cm-line-mark-warning": { backgroundColor: "var(--warning)" },
  }),
];
