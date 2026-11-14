// Completion inside a Request variable (`{{login.response.body.$.token}}`): the next
// segment of its path, from the shape of the named request's latest exchange in the
// Session (`api.exchangeShape`). Without an exchange it still offers the structure.
import { keyCompletion } from "./jsonpath";
import { matchSuggestions } from "./suggest";
import type { ExchangeShape, JsonShape } from "./types";

/** One suggestion for the segment being typed. */
export interface PathOption {
  /** What the list shows. */
  label: string;
  /** What replaces the reference from `from` to the caret. */
  insert: string;
  /**
   * The path can go on after it (it holds more keys): the caret stays inside the
   * braces. One whose insert ends with `.` needs its next segment, so completion opens again.
   */
  more?: boolean;
  /** Shown after the label: what it is, or why there's nothing more to offer. */
  detail?: string;
}

/** Suggestions for the segment being typed: each replaces the reference from offset `from` up to the caret. */
export interface PathCompletion {
  from: number;
  options: PathOption[];
  /** Why there are no paths to offer (the request hasn't been sent, its body isn't JSON). */
  hint?: string;
}

/**
 * What to offer with `typed` (a reference's text from after `{{` up to the caret)
 * when it starts with `name.`, the `# @name` of a request in the file. `exchange` is
 * that request's latest exchange, null if it hasn't been sent: then only the
 * structure is offered (`response`/`request`, `body`/`headers`), with a hint.
 * Null where `typed` can't go on as a Request variable's path.
 */
export function requestPathCompletion(typed: string, name: string, exchange: ExchangeShape | null): PathCompletion | null {
  if (!typed.startsWith(name + ".")) return null;
  const unsent = exchange ? undefined : `${name} hasn't been sent in this Session`;
  /** The fixed words of a level: each continues with another segment. */
  const structure = (from: number, partial: string, words: [string, string][]): PathCompletion => ({
    from,
    options: matchSuggestions(partial, words.map(([w]) => w)).map(({ value }) => ({
      label: value,
      insert: value + ".",
      more: true,
      detail: unsent ?? words.find(([w]) => w === value)![1],
    })),
    ...(unsent ? { hint: unsent } : {}),
  });

  const [sideText, partText, ...rest] = typed.slice(name.length + 1).split(".");
  let at = name.length + 1;
  if (partText === undefined)
    return structure(at, sideText, [
      ["response", "what came back"],
      ["request", "what was sent"],
    ]);
  if (sideText !== "response" && sideText !== "request") return null;
  const side = exchange?.[sideText];
  at += sideText.length + 1;
  if (!rest.length)
    return structure(at, partText, [
      ["body", "a JSONPath into the body, or * for all of it"],
      ["headers", "a header's value"],
    ]);
  at += partText.length + 1;
  const path = rest.join(".");

  if (partText === "headers") {
    if (!side) return { from: at, options: [], hint: unsent };
    const options = matchSuggestions(path, side.headers).map(({ value }) => ({ label: value, insert: value }));
    return { from: at, options, ...(side.headers.length ? {} : { hint: `${name}'s latest ${sideText} has no headers` }) };
  }
  if (partText !== "body") return null;
  if (!path.startsWith("$")) {
    const options: PathOption[] = [
      { label: "$", insert: "$.", more: true, detail: "a JSONPath into the body" },
      { label: "*", insert: "*", detail: "the whole body" },
    ].filter((o) => o.label.startsWith(path));
    return { from: at, options: unsent ? options.map((o) => ({ ...o, detail: unsent })) : options, ...(unsent ? { hint: unsent } : {}) };
  }
  if (!side) return { from: at, options: [], hint: unsent };
  if (!side.body) return { from: at, options: [], hint: `${name}'s latest ${sideText} body isn't JSON` };
  const body = side.body;
  const keys = keyCompletion(path, path.length, body);
  if (!keys) return null;
  const head = path.slice(0, keys.from);
  return {
    from: at + keys.from,
    options: keys.matches.map((m) => ({ label: m.value, insert: m.insert, ...(hasKeys(head + m.insert, body) ? { more: true } : {}) })),
  };
}

/** Whether the value at JSONPath `path` has keys below it, itself or in its items: `.user` → `.user.id`, `.roles` → `.roles[0].name`. */
const hasKeys = (path: string, shape: JsonShape) =>
  [".", "[*]."].some((next) => (keyCompletion(path + next, path.length + next.length, shape)?.matches.length ?? 0) > 0);
