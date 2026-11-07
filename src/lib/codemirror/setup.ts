// Shared CodeMirror configuration: theme (driven by CSS variables so it follows
// the app theme), syntax highlighting, languages, and {{variable}} support.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, Transaction, type Extension } from "@codemirror/state";
import { bodySyntaxWarnings, VAR_RE } from "../http";
import { varClass } from "../vars";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  MatchDecorator,
  placeholder as placeholderExt,
  tooltips,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { popupLayer } from "../popup/layer";
import { createFindPanel } from "./findPanel.svelte";

export type Language = "json" | "xml" | "html" | "text";

export const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text)", height: "100%", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--focus) 30%, transparent) !important",
  },
  // Opaque so horizontally scrolled content doesn't show through the sticky gutter.
  // All editors sit on --panel; a container can override with --editor-bg.
  ".cm-gutters": { backgroundColor: "var(--editor-bg, var(--panel))", color: "var(--faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--faint)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--panel-3)", border: "none", color: "var(--muted)", padding: "0 4px" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--focus) 25%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--focus) 16%, transparent)" },
  // Panels (the find bar, findPanel.svelte.ts) sit on the editor's own surface, set off by a rule.
  ".cm-panels": { backgroundColor: "var(--editor-bg, var(--panel))", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  // The shared popup surface (.popup-surface in app.css); tooltips render into the popup layer.
  ".cm-tooltip": {
    backgroundColor: "var(--popup-bg)",
    border: "var(--popup-border)",
    borderRadius: "var(--popup-radius)",
    color: "var(--text)",
    boxShadow: "var(--popup-shadow)",
    animation: "popup-in 120ms ease-out",
  },
  ".cm-tooltip-autocomplete": { overflow: "hidden" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12px", padding: "4px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { borderRadius: "5px", padding: "2px 6px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-placeholder": { color: "var(--faint)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.attributeName], color: "var(--tok-key, #9cdcfe)" },
  { tag: [t.string, t.special(t.string)], color: "var(--tok-string, #ce9178)" },
  { tag: [t.number, t.integer, t.float], color: "var(--tok-number, #b5cea8)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--tok-atom, #569cd6)" },
  { tag: [t.tagName, t.typeName], color: "var(--tok-tag, #569cd6)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.operator], color: "var(--tok-keyword, #c586c0)" },
  { tag: [t.punctuation, t.bracket, t.angleBracket], color: "var(--muted)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

export function languageExtension(lang: Language): Extension {
  switch (lang) {
    case "json":
      return json();
    case "xml":
      return xml();
    case "html":
      return html();
    default:
      return [];
  }
}

// ---------------------------------------------------------------- variables

/**
 * A `{{name}}` as it resolves: `ok` (with its fully resolved `value`), `bad` (an
 * Undefined variable), `dyn` (generated at send time), `circular` (it leads back to
 * a name already being resolved; `chain` is the names followed, e.g. `a → b → a`)
 * or `prompt` (an unanswered Prompt variable, asked when sent).
 * `secret` when a Secret (or a masked prompted value) went into the value.
 */
export interface VarInfo {
  state: "ok" | "bad" | "dyn" | "circular" | "prompt";
  value?: string;
  source?: string;
  secret?: boolean;
  chain?: string[];
}

/**
 * `text` with its references resolved, as the core's resolver does it; dynamic
 * variables and references that don't resolve are left as written. `undefined` is
 * sorted; `circular` lists each chain once, in the order found.
 */
export interface Resolution {
  value: string;
  undefined: string[];
  circular: string[][];
  /** Unanswered Prompt variables met (sorted): asked when sent, not undefined. */
  asked: string[];
  secret: boolean;
}

export interface VarProvider {
  info: (name: string) => VarInfo;
  resolve: (text: string) => Resolution;
  names: () => { name: string; detail: string }[];
}

function varDecorations(provider: VarProvider) {
  const decorator = new MatchDecorator({
    regexp: VAR_RE,
    decoration: (m) => Decoration.mark({ class: varClass(provider.info(m[1])) }),
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function varTooltip(provider: VarProvider) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(VAR_RE)) {
      const from = line.from + m.index!;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      return { pos: from, end: to, create: () => ({ dom: varCard(m[1], provider.info(m[1])) }) };
    }
    return null;
  });
}

/**
 * The hover card's content for `{{name}}`: its value (Secrets masked) and where
 * it comes from. Shared by editors' hover tooltips and VarField's static
 * rendering, so both show the same card.
 */
export function varCard(name: string, info: VarInfo): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "var-card";
  dom.style.cssText = "padding:6px 10px;font-size:12px;max-width:420px;font-family:var(--font)";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;margin-bottom:3px";
  title.textContent = name;
  const body = document.createElement("div");
  body.style.cssText = "font-family:var(--mono);word-break:break-all;color:var(--text-2)";
  if (info.state === "dyn") body.textContent = "Dynamic variable (generated at send time)";
  else if (info.state === "bad") body.textContent = "Undefined — not defined in the request, the file or the environment";
  else if (info.state === "circular") body.textContent = `Circular: ${info.chain!.join(" → ")}`;
  else if (info.state === "prompt") body.textContent = "Asked when sent";
  else body.textContent = info.secret ? "•••••••• (secret)" : info.value || "(empty)";
  dom.append(title, body);
  if (info.source) {
    const src = document.createElement("div");
    src.style.cssText = "color:var(--muted);margin-top:3px";
    src.textContent = `from ${info.source}`;
    dom.append(src);
  }
  return dom;
}

const DYNAMIC = ["$uuid", "$random.uuid", "$timestamp", "$isoTimestamp", "$randomInt", "$random.integer(0, 100)", "$random.email", "$datetime iso8601", "$processEnv NAME"];

function varCompletion(provider: VarProvider) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\{\{\s*[\w.$-]*/);
    if (!m) return null;
    const start = m.from + /\{\{\s*/.exec(m.text)![0].length;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const close = after === "}}" ? "" : "}}";
    return {
      from: start,
      options: [
        ...provider.names().map((v) => ({ label: v.name, detail: v.detail, type: "variable", apply: v.name + close })),
        ...DYNAMIC.map((d) => ({ label: d, detail: "dynamic", type: "function", apply: d + close })),
      ],
    };
  };
}

/**
 * Hover tooltips and autocomplete render into the shared popup layer, so a
 * panel's overflow can't clip them and they stack with the other popups.
 */
export const layerTooltips = (): Extension => tooltips({ parent: popupLayer() });

export function variableExtensions(provider: VarProvider): Extension {
  return [
    layerTooltips(),
    varDecorations(provider),
    varTooltip(provider),
    autocompletion({ override: [varCompletion(provider)], icons: false }),
  ];
}

// ---------------------------------------------------------------- body syntax warnings

/**
 * Highlights body lines that `.http` syntax reads as a separator or handler (see
 * `bodySyntaxWarnings`); hovering one shows the warning in a tooltip.
 */
export const bodySyntaxHighlight: Extension = [
  EditorView.decorations.compute(["doc"], (state) => {
    const b = new RangeSetBuilder<Decoration>();
    for (const w of bodySyntaxWarnings(state.doc.toString())) {
      const line = state.doc.line(w.line);
      b.add(line.from, line.from, Decoration.line({ class: "cm-syntax-warning" }));
    }
    return b.finish();
  }),
  hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    // Only the line's own warning; the scan is cheap next to a hover.
    const warning = bodySyntaxWarnings(view.state.doc.toString()).find((w) => w.line === line.number);
    if (!warning) return null;
    return {
      pos: line.from,
      end: line.to,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-syntax-warning-tip";
        dom.textContent = warning.message;
        return { dom };
      },
    };
  }),
  EditorView.theme({
    ".cm-syntax-warning": {
      backgroundColor: "color-mix(in srgb, var(--warning) 14%, transparent)",
      textDecoration: "underline wavy color-mix(in srgb, var(--warning) 70%, transparent)",
      textUnderlineOffset: "3px",
    },
    // Same text box as the app's own tooltips (TooltipHost.svelte).
    ".cm-syntax-warning-tip": { maxWidth: "360px", padding: "4px 8px", fontFamily: "var(--font)", fontSize: "12px", lineHeight: "1.4" },
  }),
];

// ---------------------------------------------------------------- presets

/**
 * Keeps the text on one line: line breaks in anything inserted (typing, a paste,
 * a drop) are removed, along with the whitespace around them, so a pasted
 * wrapped token joins up. The rest of the text is left alone.
 */
export const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  let broken = false;
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    broken ||= inserted.lines > 1;
    changes.push({ from, to, insert: inserted.sliceString(0).replace(/\s*\n\s*/g, "") });
  });
  if (!broken) return tr;
  const set = tr.startState.changes(changes);
  return { changes: set, selection: tr.startState.selection.map(set, 1), scrollIntoView: true, userEvent: tr.annotation(Transaction.userEvent) };
});

/**
 * The editing core of a single-line field (the URL bar, VarField): no line
 * breaks and history. Enter runs `onenter` (or nothing); ⌘/Ctrl+Enter runs
 * `onenter` too, and without it reaches the app's Send shortcut. Tab isn't
 * bound, so it moves focus as in a text input.
 */
export function singleLineExtensions(opts: { placeholder?: string; label?: string; onenter?: () => void }): Extension {
  const enter = opts.onenter;
  return [
    singleLine,
    history(),
    drawSelection(),
    placeholderExt(opts.placeholder ?? ""),
    EditorView.contentAttributes.of({ "aria-multiline": "false", ...(opts.label ? { "aria-label": opts.label } : {}) }),
    keymap.of([
      { key: "Enter", run: () => (enter?.(), true) },
      ...(enter ? [{ key: "Mod-Enter", run: () => (enter(), true) }] : []),
      ...completionKeymap,
      ...defaultKeymap.filter((b) => !b.key?.includes("Enter")),
      ...historyKeymap,
    ]),
  ];
}

export function editorExtensions(opts: { readonly: boolean; wrap: boolean; placeholder?: string; gutters?: boolean }): Extension {
  const ext: Extension[] = [
    layerTooltips(),
    theme,
    syntaxHighlighting(highlight),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true, createPanel: createFindPanel }),
    keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap]),
  ];
  if (opts.gutters !== false) ext.push(lineNumbers(), foldGutter(), highlightActiveLineGutter());
  if (opts.wrap) ext.push(EditorView.lineWrapping);
  if (opts.readonly) {
    ext.push(EditorState.readOnly.of(true));
  } else {
    ext.push(history(), closeBrackets(), indentOnInput(), highlightActiveLine(), keymap.of([...closeBracketsKeymap, ...completionKeymap, indentWithTab]));
  }
  if (opts.placeholder) ext.push(placeholderExt(opts.placeholder));
  return ext;
}
