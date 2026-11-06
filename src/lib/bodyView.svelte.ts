// The state behind a response's Body tab: which view the body shows, the text
// the core renders for it (Pretty JSON/XML, the Hex dump), the JSONPath filter
// and its matches, and the shape summary key completion uses. The response
// viewer owns one per mounted viewer, so the filter's matches outlive a switch
// to another tab (the status bar's Copy copies them) and nothing is fetched
// twice for the same response.

import { untrack } from "svelte";
import { api, errorMessage } from "./api";
import type { Language } from "./codemirror/setup";
import type { FilterResult, HttpResponse, JsonShape, ResponseKind } from "./types";

export type BodyMode = "pretty" | "raw" | "preview";

/** Typing pauses this long before the filter runs again on the same response. */
export const FILTER_DEBOUNCE_MS = 120;

/** Per kind of body: its editor highlighting, and the extension Save suggests (`null`: from the content type). */
export const KIND_INFO: Record<ResponseKind, { language: Language; ext: string | null; preview: boolean }> = {
  json: { language: "json", ext: "json", preview: false },
  xml: { language: "xml", ext: "xml", preview: false },
  html: { language: "html", ext: "html", preview: true },
  image: { language: "text", ext: null, preview: true },
  pdf: { language: "text", ext: null, preview: true },
  media: { language: "text", ext: null, preview: true },
  text: { language: "text", ext: null, preview: false },
  binary: { language: "text", ext: null, preview: false },
};

/** The file name Save suggests for a response: `response.<ext>`, the extension by kind or else from the content type. */
export function saveName(res: HttpResponse): string {
  const ext = KIND_INFO[res.bodyKind].ext ?? (res.contentType ?? "").toLowerCase().split("/")[1]?.split(";")[0] ?? "bin";
  return `response.${ext}`;
}

/** What the Body view is built from: the response, and the choices the viewer remembers per editor tab. */
export interface BodyViewInput {
  res: HttpResponse | undefined;
  mode: BodyMode;
  /** The filter expression as typed. */
  filter: string;
}

export class BodyView {
  /** Set by the constructor, before anything reads it (the derived values below are lazy). */
  #input: () => BodyViewInput = () => ({ res: undefined, mode: "pretty", filter: "" });

  /** Call during component set-up: the loaders are effects of the calling component. */
  constructor(input: () => BodyViewInput) {
    this.#input = input;
    $effect(() => this.#loadRendered());
    $effect(() => this.#runFilter());
  }

  readonly res = $derived(this.#input().res);
  readonly kind = $derived<ResponseKind>(this.res?.bodyKind ?? "binary");
  readonly canPreview = $derived(KIND_INFO[this.kind].preview);
  /** A body that isn't text (still-encoded bytes count as binary). */
  readonly isBinary = $derived(!!this.res && this.res.bodyText === null);
  /** The view actually shown: a binary body has Hex (or Preview), and Preview only where there is one. */
  readonly effectiveMode = $derived.by<BodyMode>(() => {
    const mode = this.#input().mode;
    if (this.isBinary) return this.canPreview && mode !== "raw" ? "preview" : "raw";
    return mode === "preview" && !this.canPreview ? "pretty" : mode;
  });
  readonly dataUrl = $derived(this.res?.bodyBase64 ? `data:${this.res.contentType ?? "application/octet-stream"};base64,${this.res.bodyBase64}` : null);

  // Text the core renders for the editor, from the body the shell stored:
  // Pretty JSON/XML from its lossless formatter (numbers and text stay as the
  // server sent them), or the Hex view of a binary body. A small body's Pretty
  // text arrives with the response; a large one's is asked for once, when
  // Pretty is opened, with a loading state meanwhile. If the body doesn't
  // parse or is no longer stored, Pretty shows the raw text.

  /** Which rendered text the view needs, as `"<json|xml|hex>:<response id>"`; null for none. */
  readonly renderedKey = $derived.by(() => {
    const res = this.res;
    if (!res) return null;
    if (res.bodyText === null) return this.effectiveMode === "preview" && this.dataUrl ? null : `hex:${res.id}`;
    if (this.effectiveMode === "pretty" && (this.kind === "json" || this.kind === "xml")) return `${this.kind}:${res.id}`;
    return null;
  });
  #rendered = $state<{ key: string; text: string } | null>(null);

  #loadRendered() {
    const key = this.renderedKey;
    const res = this.res;
    if (!key || !res || res.prettyText != null || untrack(() => this.#rendered?.key) === key) return;
    const { id, bodyText: raw } = res;
    const keep = (text: string) => {
      if (this.res?.id === id) this.#rendered = { key, text }; // a newer response may have arrived
    };
    if (raw === null) api.hexdump(id).then(keep, (e) => keep(`(${errorMessage(e)})`));
    else api.prettyResponse(id).then(keep, () => keep(raw));
  }

  // The JSONPath filter runs in the core against the stored body, by response
  // id, so a re-send re-runs it on the new response. Only for whole JSON bodies;
  // otherwise the expression is kept for the next JSON response in this tab.

  readonly canFilter = $derived(!!this.res && this.kind === "json" && this.res.bodyText !== null && !this.res.truncated);
  readonly #expression = $derived(this.canFilter ? this.#input().filter.trim() : "");
  #filterOutcome = $state<{ id: string; expression: string; result?: FilterResult; error?: string } | null>(null);

  #runFilter() {
    const res = this.res;
    const expr = this.#expression;
    if (!res || !expr) return;
    const { id } = res;
    const last = untrack(() => this.#filterOutcome);
    if (last?.id === id && last.expression === expr) return;
    const settle = (outcome: { result?: FilterResult; error?: string }) => {
      if (this.res?.id === id && this.#expression === expr) this.#filterOutcome = { id, expression: expr, ...outcome };
    };
    // A new response is filtered at once; typing waits for a pause.
    const timer = setTimeout(
      () => api.filterResponse(id, expr).then((result) => settle({ result }), (e) => settle({ error: errorMessage(e) })),
      last?.id === id ? FILTER_DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(timer);
  }

  // This response's latest outcome. While a newer expression runs, its last
  // matches stay up, so typing doesn't flash the full body.
  readonly #outcome = $derived(this.#expression && this.#filterOutcome?.id === this.res?.id ? this.#filterOutcome : null);
  /** Why the current expression couldn't run. */
  readonly filterError = $derived(this.#outcome?.expression === this.#expression ? (this.#outcome.error ?? null) : null);
  /** The matches on screen (the body view is then always pretty, and Copy copies them). */
  readonly filtered = $derived(this.#outcome?.result && !this.filterError ? this.#outcome.result : null);
  /** A large body's Pretty text is still on its way (filter matches show instead, if any). */
  readonly formatting = $derived(
    !this.filtered && !!this.renderedKey && this.res?.bodyText != null && this.res.prettyText == null && this.#rendered?.key !== this.renderedKey,
  );

  /** The editor's text: filter matches, else the Pretty or Hex text once it's there, else the raw body. */
  readonly text = $derived.by(() => {
    const res = this.res;
    if (!res) return "";
    if (this.filtered) return this.filtered.text;
    if (this.renderedKey && res.bodyText !== null && res.prettyText != null) return res.prettyText;
    if (this.renderedKey && this.#rendered?.key === this.renderedKey) return this.#rendered.text;
    return res.bodyText ?? "";
  });

  // Key completion: the body's shape summary, built once per response in the
  // core and fetched once when the filter box is first focused; every keystroke
  // completes from it locally.

  /** The shape asked for (by response id), and what came back (null until it does, or if it failed). */
  #shapeFetch = $state<{ id: string; shape: JsonShape | null } | null>(null);
  readonly shape = $derived(this.res && this.#shapeFetch?.id === this.res.id ? this.#shapeFetch.shape : null);

  /** Fetches this response's shape, once. */
  loadShape() {
    const res = this.res;
    if (!res || !this.canFilter || this.#shapeFetch?.id === res.id) return;
    const { id } = res;
    this.#shapeFetch = { id, shape: null }; // asked for; one request per response
    api.responseShape(id).then(
      (shape) => {
        if (this.#shapeFetch?.id === id) this.#shapeFetch = { id, shape };
      },
      () => {}, // no completion, the filter still works
    );
  }
}
