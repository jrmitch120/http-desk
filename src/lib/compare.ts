// Compare (#158): the texts a comparison diffs for each side. The body as the shell lays
// it out for Compare (JSON with its keys sorted, by the lossless formatter, so key order
// and spacing don't show; ADR-0006: fetched by response id), and the headers one per
// line, sorted by name, after the status line.
import { api, errorMessage } from "./api";
import { formatBytes, formatLimit } from "./http";
import { KIND_INFO } from "./bodyView.svelte";
import type { Language } from "./codemirror/setup";
import type { HttpResponse } from "./types";

/** One side of a comparison: its label, and its response, or why it has none. */
export interface CompareSide {
  /** "current response", or when the entry was sent. */
  label: string;
  response: HttpResponse | null;
  /** The send error of an entry that got no response. */
  error?: string;
  cancelled?: boolean;
}

/** The side's headers as Compare diffs them: the status line, then `name: value` sorted by name (repeats keep their order). */
export function headersText(side: CompareSide): string {
  const res = side.response;
  if (!res) return side.cancelled ? "Cancelled" : `Error: ${side.error ?? "no response"}`;
  const lines = res.headers.map(([name, value]) => [name.toLowerCase(), value] as const);
  lines.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [`${res.httpVersion} ${res.status} ${res.statusText}`.trim(), ...lines.map(([n, v]) => `${n}: ${v}`)].join("\n");
}

/**
 * The largest text body Compare diffs: 1 MB. Past it, laying out both bodies and
 * diffing them in the merge view would hold up the window, so Compare says they're
 * too large (`tooLargeToCompare`) and compares their headers only.
 */
export const COMPARE_BODY_LIMIT = 1024 * 1024;

/** Compare's body limit as the UI says it: "1 MB". */
export const COMPARE_BODY_LIMIT_TEXT = formatLimit(COMPARE_BODY_LIMIT);

/** Whether either side's body is a text body over `COMPARE_BODY_LIMIT`, so the bodies aren't compared. */
export function tooLargeToCompare(...sides: CompareSide[]): boolean {
  return sides.some(({ response: r }) => !!r && !KIND_INFO[r.bodyKind].binary && r.bodySize > COMPARE_BODY_LIMIT);
}

/** The side's body as Compare diffs it; a binary body by its kind and size, as it isn't compared as text. */
export async function bodyText(side: CompareSide): Promise<string> {
  const res = side.response;
  if (!res) return "";
  if (KIND_INFO[res.bodyKind].binary) return `(${res.bodyKind} body, ${formatBytes(res.bodySize)})`;
  try {
    return new TextDecoder().decode(await api.responseBody(res.id, "compare"));
  } catch (e) {
    return `(${errorMessage(e)})`;
  }
}

/** The highlighting for two bodies: their language when both share it, else plain text. */
export function compareLanguage(a: CompareSide, b: CompareSide): Language {
  const la = a.response && KIND_INFO[a.response.bodyKind].language;
  const lb = b.response && KIND_INFO[b.response.bodyKind].language;
  return la && la === lb ? la : "text";
}
