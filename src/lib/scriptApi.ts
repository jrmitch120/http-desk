// Completion for the JetBrains script API in the Scripts editor (Settings).
//
// It offers only what HttpDesk implements, read from the one list of it,
// `crates/httpdesk-core/src/script/api.json`, next to the prelude that
// implements it. A core test (`tests/scripts.rs`) checks that list against the
// prelude, so a ticket that implements an API lists it there and completion
// offers it with no change here.

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import api from "../../crates/httpdesk-core/src/script/api.json";
import type { ScriptKind } from "./scripts";

/** One implemented API: its full name (`client.test`), its signature or type, and what it does. */
export interface ScriptApi {
  name: string;
  detail: string;
  info: string;
}

export const SCRIPT_API: readonly ScriptApi[] = api;

/** The API a script of `kind` can use: a pre-request script has no response yet,
 * and only a pre-request script has `request` (a handler's isn't implemented). */
const available = (kind: ScriptKind) =>
  SCRIPT_API.filter((a) => !a.name.startsWith(kind === "handler" ? "request." : "response."));

/** Syntax the API isn't completed in. */
const QUIET = new Set(["String", "TemplateString", "LineComment", "BlockComment"]);

/** The members of `path` (`""` for the roots) among `apis`, each once. */
function members(apis: readonly ScriptApi[], path: string): Completion[] {
  const prefix = path ? path + "." : "";
  const seen = new Map<string, Completion>();
  for (const a of apis) {
    if (!a.name.startsWith(prefix)) continue;
    const [label, ...deeper] = a.name.slice(prefix.length).split(".");
    if (seen.has(label)) continue;
    seen.set(
      label,
      deeper.length
        ? { label, type: "namespace" }
        : { label, type: a.detail.startsWith("(") ? "function" : "property", detail: a.detail, info: a.info },
    );
  }
  return [...seen.values()];
}

/** Completes `client.`, `response.`, `request.` and their members, as far as HttpDesk implements them. */
export function scriptCompletion(kind: ScriptKind): CompletionSource {
  const apis = available(kind);
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[\w$.]*/);
    if (!word || (word.text === "" && !ctx.explicit)) return null;
    const tree = ensureSyntaxTree(ctx.state, ctx.pos, 50) ?? syntaxTree(ctx.state);
    if (QUIET.has(tree.resolveInner(ctx.pos, -1).name)) return null;
    const dot = word.text.lastIndexOf(".");
    const path = dot < 0 ? "" : word.text.slice(0, dot);
    const options = members(apis, path);
    if (!options.length) return null;
    return { from: word.from + dot + 1, options, validFor: /^[\w$]*$/ };
  };
}
