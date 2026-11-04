// Shared CodeMirror configuration: theme (driven by CSS variables so it follows
// the app theme), syntax highlighting, languages, and {{variable}} support.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
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
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--faint)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--panel-3)", border: "none", color: "var(--muted)", padding: "0 4px" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--focus) 25%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--focus) 16%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-search": { fontFamily: "var(--font)", fontSize: "12px", padding: "6px 8px" },
  ".cm-search input, .cm-search button, .cm-search label": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--text)",
    padding: "3px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--panel-3)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--text)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--panel-2)",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    color: "var(--text)",
    boxShadow: "var(--shadow)",
  },
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

export interface VarInfo {
  state: "ok" | "bad" | "dyn";
  value?: string;
  source?: string;
  secret?: boolean;
}

export interface VarProvider {
  info: (name: string) => VarInfo;
  names: () => { name: string; detail: string }[];
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function varDecorations(provider: VarProvider) {
  const decorator = new MatchDecorator({
    regexp: VAR_RE,
    decoration: (m) => Decoration.mark({ class: `cm-var cm-var-${provider.info(m[1]).state}` }),
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
      const info = provider.info(m[1]);
      return {
        pos: from,
        end: to,
        create() {
          const dom = document.createElement("div");
          dom.style.cssText = "padding:6px 10px;font-size:12px;max-width:420px;font-family:var(--font)";
          const title = document.createElement("div");
          title.style.cssText = "font-weight:600;margin-bottom:3px";
          title.textContent = m[1];
          const body = document.createElement("div");
          body.style.cssText = "font-family:var(--mono);word-break:break-all;color:var(--text-2)";
          if (info.state === "dyn") body.textContent = "Dynamic variable (generated at send time)";
          else if (info.state === "bad") body.textContent = "Unresolved — not defined in the environment or file";
          else body.textContent = info.secret ? "•••••••• (secret)" : info.value || "(empty)";
          dom.append(title, body);
          if (info.source) {
            const src = document.createElement("div");
            src.style.cssText = "color:var(--muted);margin-top:3px";
            src.textContent = `from ${info.source}`;
            dom.append(src);
          }
          return { dom };
        },
      };
    }
    return null;
  });
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

export function variableExtensions(provider: VarProvider): Extension {
  return [
    // Render tooltips (hover and autocomplete) into <body> so overflow/stacking
    // of surrounding panels can't clip them.
    tooltips({ parent: document.body }),
    varDecorations(provider),
    varTooltip(provider),
    autocompletion({ override: [varCompletion(provider)], icons: false }),
  ];
}

// ---------------------------------------------------------------- presets

export function editorExtensions(opts: { readonly: boolean; wrap: boolean; placeholder?: string; gutters?: boolean }): Extension {
  const ext: Extension[] = [
    theme,
    syntaxHighlighting(highlight),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
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
