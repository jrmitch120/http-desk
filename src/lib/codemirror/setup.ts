// Shared CodeMirror configuration: theme (driven by CSS variables so it follows
// the app theme), syntax highlighting, languages, and {{variable}} support.
import { autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, Transaction, type Extension } from "@codemirror/state";
import { bodySyntaxWarnings, segments } from "../http";
import { MASK, requestVariable, varClass } from "../vars";
import type { PathCompletion } from "../requestPaths";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  closeHoverTooltips,
  hoverTooltip,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  tooltips,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { popupLayer } from "../popup/layer";
import { createFindPanel } from "./findPanel.svelte";
import { findInPieces } from "./findInPieces";
import { scrollJumps } from "./scrollJumps";
import { extractExtension } from "./extract";

export type Language = "json" | "xml" | "html" | "javascript" | "text";

export const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text)", height: "100%", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  // No ligatures: shaping JetBrains Mono's ligatures (mostly contextual
  // alternates, `calt`) made WebKit draw lines tens of thousands of characters
  // long so slowly that paging through such a body showed blank text (#118).
  // `font-variant-ligatures: none` alone should cover `calt` and `liga`; the
  // feature settings say so outright, as in the fix checked in the macOS app.
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.55",
    fontVariantLigatures: "none",
    fontFeatureSettings: '"calt" 0, "liga" 0',
  },
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
  // After the label, a dynamic variable's argument hint; after the source, a value preview, a
  // dynamic variable's description, or "secret" in place of a Secret's value.
  ".cm-completionArgs": { color: "var(--muted)", marginLeft: "6px" },
  ".cm-completionPreview, .cm-completionDescription, .cm-completionSecret": {
    display: "inline-block",
    maxWidth: "300px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
    marginLeft: "10px",
    color: "var(--text-2)",
  },
  ".cm-completionDescription": { fontFamily: "var(--font)" },
  ".cm-completionSecret": { color: "var(--var-secret)", fontStyle: "italic", fontFamily: "var(--font)" },
  // A row that only explains why a Request variable's path has nothing to offer.
  ".cm-completionHint": { color: "var(--muted)", fontStyle: "italic", fontFamily: "var(--font)" },
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
    case "javascript":
      return javascript();
    default:
      return [];
  }
}

// ---------------------------------------------------------------- variables

/**
 * A `{{name}}` as it resolves: `ok` (with its fully resolved `value`), `bad` (an
 * Undefined variable), `dyn` (generated at send time), `circular` (it leads back to
 * a name already being resolved; `chain` is the names followed, e.g. `a → b → a`)
 * `prompt` (an unanswered Prompt variable, asked when sent) or `request` (a Request
 * variable of a request named in the file, read from its latest exchange when sent).
 * `secret` when a Secret (or a masked prompted value) went into the value.
 */
export interface VarInfo {
  state: "ok" | "bad" | "dyn" | "circular" | "prompt" | "request";
  value?: string;
  source?: string;
  secret?: boolean;
  chain?: string[];
  /** Where the definition in use can be edited, if the app has a row for it. */
  definition?: Definition;
}

/**
 * Where a variable's definition can be edited: a File variable at the top of the
 * file in the request's Settings (`file`); one declared in a request block (`request`:
 * the request's own, else the last request in the file declaring it), at its line in
 * that request's `.http` source; or a variable of an environment in the Environments
 * modal (`env` is `$shared` for the shared variables), in the pair of env files of
 * folder `dir` (relative to the workspace root, `""` for the root; without it, the
 * folder the modal shows or would open on).
 */
export type Definition =
  | { kind: "file"; name: string }
  | { kind: "request"; name: string }
  | { kind: "env"; env: string; name: string; dir?: string };

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

/**
 * An autocomplete entry: a name in scope, with where it comes from and a short
 * preview of its resolved value (none for a Secret, or a value a Secret went
 * into), or a dynamic variable with its argument hint and description.
 */
export interface VarCompletion {
  name: string;
  source: "file" | "environment" | "shared" | "prompt" | "request" | "dynamic";
  preview?: string;
  secret?: boolean;
  /** Dynamic variables: the argument hint (empty without arguments). */
  args?: string;
  description?: string;
  /** Dynamic variables that generate nothing without their argument. */
  required?: boolean;
}

export interface VarProvider {
  info: (name: string) => VarInfo;
  resolve: (text: string) => Resolution;
  /** What `{{` offers: the names in scope (one entry each), then the dynamic variables. */
  completions: () => VarCompletion[];
  /**
   * Inside a Request variable (`typed` is the reference from after `{{` up to the
   * caret, `login.response.body.$.`): its path's next segment. Null when `typed`
   * isn't a path of a named request, and `completions` applies.
   */
  pathCompletions?: (typed: string) => Promise<PathCompletion | null>;
  /** Opens a definition's row (the hover card's Edit); without it the card has no Edit. */
  edit?: (definition: Definition) => void;
  /** Lists where a variable is used (the hover card's Find usages); without it the card has none. */
  findUsages?: (name: string) => void;
  /**
   * Extract to variable on selected text: asks for a name and defines it,
   * resolving to the name (null if cancelled); the field then puts `{{name}}` in
   * place of the selection. Without it fields don't offer Extract to variable.
   */
  extract?: (value: string) => Promise<string | null>;
}

/** The `{{…}}` references on the visible lines, as `segments` reads them (like the resolver): document range and name. */
function* visibleReferences(view: EditorView): Generator<{ from: number; to: number; name: string }> {
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const s of segments(line.text)) if (s.ref !== undefined) yield { from: line.from + s.from, to: line.from + s.from + s.text.length, name: s.ref };
      pos = line.to + 1;
    }
  }
}

function varDecorations(provider: VarProvider) {
  const build = (view: EditorView) => {
    const b = new RangeSetBuilder<Decoration>();
    for (const r of visibleReferences(view)) b.add(r.from, r.to, Decoration.mark({ class: varClass(provider.info(r.name)) }));
    return b.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function varTooltip(provider: VarProvider) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const s of segments(line.text)) {
      if (s.ref === undefined) continue;
      const [from, to, name] = [line.from + s.from, line.from + s.from + s.text.length, s.ref];
      if (pos < from || pos > to) continue;
      const close = () => view.dispatch({ effects: closeHoverTooltips });
      return { pos: from, end: to, create: () => ({ dom: varCard(name, provider.info(name), { edit: provider.edit, findUsages: provider.findUsages, close }) }) };
    }
    return null;
  });
}

/**
 * The hover card's content for `{{name}}`: its value and where it comes from. A
 * Secret (or a value a Secret went into) is masked until Reveal, in this card
 * only. With `edit` and a definition that has a row in the app, Edit closes the
 * card (`close`) and opens that row; with `findUsages`, Find usages closes it and
 * lists the references to a named (not `$`) variable. Shared by editors' hover
 * tooltips and VarField's static rendering, so both show the same card.
 */
export function varCard(
  name: string,
  info: VarInfo,
  actions: { edit?: (d: Definition) => void; findUsages?: (name: string) => void; close?: () => void } = {},
): HTMLElement {
  const div = (cls: string, text = "") => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const dom = div("var-card");
  const body = div("var-card-value");
  const masked = info.state === "ok" && !!info.secret;
  let revealed = false;
  const showValue = () => (body.textContent = masked && !revealed ? `${MASK} (secret)` : info.value || "(empty)");
  if (info.state === "dyn") body.textContent = "Dynamic variable (generated at send time)";
  else if (info.state === "bad")
    body.textContent = name.startsWith("$")
      ? "Undefined — not a dynamic variable"
      : requestVariable(name)
        ? `Undefined — no request in this file has # @name ${requestVariable(name)!.name}`
        : "Undefined — not defined in the request, the file or the environment";
  else if (info.state === "circular") body.textContent = `Circular: ${info.chain!.join(" → ")}`;
  else if (info.state === "prompt") body.textContent = "Asked when sent";
  else if (info.state === "request") body.textContent = "Request variable (read when sent)";
  else showValue();
  dom.append(div("var-card-name", name), body);
  if (info.source) dom.append(div("var-card-source", `from ${info.source}`));

  const buttons: HTMLButtonElement[] = [];
  const button = (label: string, onclick: (b: HTMLButtonElement) => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small ghost";
    b.textContent = label;
    b.addEventListener("click", () => onclick(b));
    buttons.push(b);
  };
  if (masked)
    button("Reveal", (b) => {
      revealed = !revealed;
      b.textContent = revealed ? "Hide" : "Reveal";
      showValue();
    });
  const { edit, findUsages, close } = actions;
  const definition = info.definition;
  if (edit && definition)
    button("Edit", () => {
      close?.();
      edit(definition);
    });
  // Any named variable, defined or not; a `$name` is never looked up.
  if (findUsages && !name.startsWith("$"))
    button("Find usages", () => {
      close?.();
      findUsages(name);
    });
  if (buttons.length) {
    const row = div("var-card-actions");
    row.append(...buttons);
    dom.append(row);
    // A press in the card keeps focus where it is: an editor that lost it would
    // close, taking its card (and the click) with it.
    dom.addEventListener("mousedown", (e) => e.preventDefault());
  }
  return dom;
}

function varCompletion(provider: VarProvider) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    // Paths can hold brackets and quotes: `{{login.response.body.$.items[0]['odd key']`.
    const m = ctx.matchBefore(/\{\{\s*[^{}\s][^{}]*|\{\{\s*/);
    if (!m) return null;
    const start = m.from + /\{\{\s*/.exec(m.text)![0].length;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const close = after === "}}" ? "" : "}}";
    const typed = ctx.state.sliceDoc(start, ctx.pos);
    const path = await provider.pathCompletions?.(typed);
    if (ctx.aborted) return null;
    if (path) return pathResult(start, path, close);
    // Names in scope are plain words: anything else isn't a reference being typed.
    if (!/^[\w.$-]*$/.test(typed)) return null;
    return {
      from: start,
      options: provider.completions().map((c): VarOption => {
        // A named request goes on with its path (`{{login.|}}`), completed next.
        if (c.source === "request") return { label: c.name, detail: "request", type: "variable", apply: applyWithCaret(c.name + ".", close), entry: c, reopen: true };
        // One that needs its argument leaves the caret where it goes: `{{$processEnv |}}`.
        const text = c.required ? c.name + (c.name.endsWith(".") ? "" : " ") : c.name;
        return {
          label: c.name,
          detail: c.source,
          type: c.source === "dynamic" ? "function" : "variable",
          // The names in scope before the dynamic variables, which would sort first (`$`).
          boost: c.source === "dynamic" ? -1 : 0,
          apply: c.required ? applyWithCaret(text, close) : text + close,
          entry: c,
        };
      }),
    };
  };
}

/** A Request variable's next path segment, already matched against what's typed (so CodeMirror doesn't filter). */
function pathResult(start: number, path: PathCompletion, close: string): CompletionResult {
  const options = path.options.map(
    (o): VarOption => ({
      label: o.label,
      type: "property",
      apply: o.more ? applyWithCaret(o.insert, close) : o.insert + close,
      entry: { name: o.label, source: "request", ...(o.detail ? { description: o.detail } : {}) },
      reopen: o.insert.endsWith("."),
    }),
  );
  // Nothing to offer, and why: a row that changes nothing when picked.
  if (!options.length && path.hint) options.push({ label: path.hint, type: "text", apply: (view) => closeCompletion(view), entry: { name: path.hint, source: "request" }, hint: true });
  return { from: start + path.from, options, filter: false };
}

/** `reopen`: completion opens again after it's picked, for the next path segment. `hint`: a row that only explains. */
type VarOption = Completion & { entry: VarCompletion; reopen?: boolean; hint?: boolean };

function applyWithCaret(text: string, close: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) =>
    view.dispatch({
      changes: { from, to, insert: text + close },
      selection: { anchor: from + text.length },
      annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")],
    });
}

/** An autocomplete option's argument hint (after the name) and its value preview or description (after the source). */
const completionColumns = [
  {
    position: 60,
    render(c: Completion) {
      const args = (c as VarOption).entry?.args;
      if (!args) return null;
      const el = document.createElement("span");
      el.className = "cm-completionArgs";
      el.textContent = args;
      return el;
    },
  },
  {
    position: 90,
    render(c: Completion) {
      const e = (c as VarOption).entry;
      const text = e?.secret ? "secret" : (e?.description ?? e?.preview);
      if (!text) return null;
      const el = document.createElement("span");
      el.className = e.secret ? "cm-completionSecret" : e.description ? "cm-completionDescription" : "cm-completionPreview";
      el.textContent = text;
      return el;
    },
  },
];

/**
 * Hover tooltips and autocomplete render into the shared popup layer, so a
 * panel's overflow can't clip them and they stack with the other popups.
 */
export const layerTooltips = (): Extension => tooltips({ parent: popupLayer() });

/**
 * `{{variable}}` marks, hover cards, autocompletion and Extract to variable
 * (when the provider has `extract`). With `marks: false` only the
 * autocompletion: for a masked field, where a mark, a card or extracting the
 * selection would give the hidden text away.
 */
export function variableExtensions(provider: VarProvider, { marks = true }: { marks?: boolean } = {}): Extension {
  return [
    layerTooltips(),
    marks ? [varDecorations(provider), varTooltip(provider), extractExtension(provider)] : [],
    autocompletion({
      override: [varCompletion(provider)],
      icons: false,
      addToOptions: completionColumns,
      // A named request or a path segment ending in `.` goes on with the next segment.
      activateOnCompletion: (c) => !!(c as VarOption).reopen,
      optionClass: (c) => ((c as VarOption).hint ? "cm-completionHint" : ""),
    }),
  ];
}

/**
 * Draws the text as discs, as a password input does, and keeps it off the
 * clipboard. The placeholder stays readable.
 */
export const masked: Extension = [
  EditorView.editorAttributes.of({ class: "cm-masked" }),
  EditorView.domEventHandlers({
    copy: (e) => (e.preventDefault(), true),
    cut: (e) => (e.preventDefault(), true),
    dragstart: (e) => (e.preventDefault(), true),
  }),
  EditorView.theme({
    "&.cm-masked .cm-content": { WebkitTextSecurity: "disc" },
    "&.cm-masked .cm-placeholder": { WebkitTextSecurity: "none" },
  }),
];

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
 * breaks and history. Enter runs `onenter` (or nothing); ⌘Enter / Ctrl+Enter runs
 * `onenter` too, and without it reaches the app's Send shortcut. Tab isn't
 * bound, so it moves focus as in a text input, and neither is Escape (unless
 * the autocomplete list is open), so it reaches a modal.
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
      // Escape is left to the owner (a modal closes), as in a text input; the `{{` list still takes it while open.
      ...defaultKeymap.filter((b) => !b.key?.includes("Enter") && b.key !== "Escape"),
      ...historyKeymap,
    ]),
  ];
}

export function editorExtensions(opts: { readonly: boolean; wrap: boolean; placeholder?: string; gutters?: boolean }): Extension {
  const ext: Extension[] = [
    layerTooltips(),
    scrollJumps,
    theme,
    syntaxHighlighting(highlight),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    findInPieces, // ahead of searchKeymap, whose find next and previous keys it takes over
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
