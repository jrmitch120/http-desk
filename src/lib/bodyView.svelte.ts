// The state behind a response's Body tab: which view the body shows, the text
// fetched from the shell for it (raw, Pretty JSON/XML, the Hex dump), the JSONPath filter
// and its matches, and the shape summary key completion uses. The response
// viewer owns one per mounted viewer, so the filter's matches outlive a switch
// to another tab (the status bar's Copy copies them) and nothing is fetched
// twice for the same response.

import { untrack } from "svelte";
import { api, errorMessage } from "./api";
import type { Language } from "./codemirror/setup";
import type { FilterResult, HttpResponse, JsonShape, ResponseKind } from "./types";

export type BodyMode = "pretty" | "raw" | "preview";
/** A text the editor can show for a body: its raw text, its Pretty text, or (binary) its Hex dump. */
type TextView = "raw" | "pretty" | "hex";

/** Typing pauses this long before the filter runs again on the same response. */
export const FILTER_DEBOUNCE_MS = 120;

/**
 * Per kind of body: its editor highlighting, the extension Save suggests (`null`:
 * from the content type), whether the core can format it for Pretty (only JSON
 * and XML; for anything else Pretty would show the raw text), whether it has a
 * Preview, and whether it's binary (Hex instead of Raw, copied as base64).
 */
export const KIND_INFO: Record<ResponseKind, { language: Language; ext: string | null; pretty: boolean; preview: boolean; binary: boolean }> = {
  json: { language: "json", ext: "json", pretty: true, preview: false, binary: false },
  xml: { language: "xml", ext: "xml", pretty: true, preview: false, binary: false },
  html: { language: "html", ext: "html", pretty: false, preview: true, binary: false },
  image: { language: "text", ext: null, pretty: false, preview: true, binary: true },
  pdf: { language: "text", ext: null, pretty: false, preview: true, binary: true },
  media: { language: "text", ext: null, pretty: false, preview: true, binary: true },
  text: { language: "text", ext: null, pretty: false, preview: false, binary: false },
  binary: { language: "text", ext: null, pretty: false, preview: false, binary: true },
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
    $effect(() => this.#loadText());
    $effect(() => this.#runFilter());
    $effect(() => this.#loadPreview());
    $effect(() => () => this.#revokePreview());
  }

  readonly res = $derived(this.#input().res);
  readonly kind = $derived<ResponseKind>(this.res?.bodyKind ?? "binary");
  readonly canPretty = $derived(KIND_INFO[this.kind].pretty);
  readonly canPreview = $derived(KIND_INFO[this.kind].preview);
  /** A body that isn't text, by its kind (the core makes still-encoded bytes binary). */
  readonly isBinary = $derived(!!this.res && KIND_INFO[this.kind].binary);
  /**
   * The view actually shown. A binary body has Hex (or Preview); otherwise a view
   * the body doesn't have (Pretty for HTML or text, Preview for JSON) falls back to
   * one it does. The tab's remembered choice is left alone, so the next JSON
   * response in it opens in Pretty again.
   */
  readonly effectiveMode = $derived.by<BodyMode>(() => {
    const mode = this.#input().mode;
    if (this.isBinary) return this.canPreview && mode !== "raw" ? "preview" : "raw";
    if (mode === "pretty" && !this.canPretty) return "raw";
    if (mode === "preview" && !this.canPreview) return this.canPretty ? "pretty" : "raw";
    return mode;
  });
  /** Whether Preview shows the body itself (any kind that has a preview, at any size). */
  readonly showingPreview = $derived(this.effectiveMode === "preview");
  /** Whether a preview may stay mounted while hidden. Audio and video don't, so switching away stops them playing. */
  readonly previewStaysMounted = $derived(this.kind !== "media");

  // Preview loads the body from a `blob:` URL: its bytes fetched from the shell
  // by response id (never base64 or text from the send reply), typed with the
  // response's content type. Fetched once per response, when Preview is first
  // shown. A re-sent response's preview keeps showing the previous one until
  // its own URL is made, and then the previous URL is revoked; the last one is
  // revoked when the viewer goes (its tab is closed or switched away from).

  /** The preview's `blob:` URL (or why the bytes couldn't be fetched), for the response it was made for. */
  #preview = $state.raw<{ id: string; kind: ResponseKind; url?: string; error?: string } | null>(null);
  /** The response whose bytes are being fetched for Preview. */
  #previewFetching: string | null = null;
  /** The `blob:` URL Preview shows (the previous response's while this one's is made, if it's the same kind); null until there's one. */
  readonly previewUrl = $derived(this.#preview?.kind === this.kind ? (this.#preview.url ?? null) : null);
  /** Why this response's bytes couldn't be fetched for Preview. */
  readonly previewError = $derived(this.#preview?.id === this.res?.id ? (this.#preview?.error ?? null) : null);

  #loadPreview() {
    const res = this.res;
    if (!res || !this.showingPreview) return;
    const { id } = res;
    if (this.#previewFetching === id || untrack(() => this.#preview?.id === id)) return;
    this.#previewFetching = id;
    const { kind } = this;
    const type = res.contentType ?? "application/octet-stream";
    const show = (next: { url?: string; error?: string }) => {
      if (this.#previewFetching === id) this.#previewFetching = null;
      if (this.#destroyed || this.res?.id !== id) {
        if (next.url) URL.revokeObjectURL(next.url); // a newer response arrived first
        return;
      }
      const old = this.#preview?.url;
      this.#preview = { id, kind, ...next };
      if (old) URL.revokeObjectURL(old);
    };
    api.responseBody(id, "bytes").then(
      (bytes) => show({ url: URL.createObjectURL(new Blob([bytes], { type })) }),
      (e) => show({ error: `(${errorMessage(e)})` }),
    );
  }

  /** Set once the viewer is gone, so a fetch finishing afterwards makes no URL that outlives it. */
  #destroyed = false;
  #revokePreview() {
    this.#destroyed = true;
    if (this.#preview?.url) URL.revokeObjectURL(this.#preview.url);
  }

  // The editor's text, fetched from the shell by response id (never taken from
  // the send reply): the raw text or the Pretty JSON/XML from its lossless
  // formatter (numbers and text stay as the server sent them), as UTF-8 bytes
  // decoded here, or the Hex view of a binary body. Each is fetched once per
  // response, and only when its view is shown, with a loading state meanwhile.
  // If the body has no Pretty text (it doesn't parse), Pretty shows the raw
  // text; if it's no longer stored, the editor says so.

  /** The text the editor shows for the current view; null while the body shows as a preview. */
  readonly #textView = $derived.by<TextView | null>(() => {
    if (!this.res) return null;
    if (this.isBinary) return this.effectiveMode === "preview" ? null : "hex";
    if (this.effectiveMode === "preview") return null;
    return this.effectiveMode === "pretty" && this.canPretty ? "pretty" : "raw";
  });
  /** The texts fetched for the response they were last fetched for, by view. */
  #texts = $state.raw<{ id: string; byView: Partial<Record<TextView, string>> }>({ id: "", byView: {} });
  /** Fetches in flight, as `"<view>:<response id>"`, so none is asked for twice. */
  #fetching = new Set<string>();

  #loadText() {
    const res = this.res;
    const view = this.#textView;
    if (!res || !view) return;
    const { id } = res;
    const key = `${view}:${id}`;
    if (this.#fetching.has(key) || untrack(() => this.#texts.id === id && this.#texts.byView[view] !== undefined)) return;
    this.#fetching.add(key);
    const keep = (texts: Partial<Record<TextView, string>>) => {
      this.#fetching.delete(key);
      if (this.#texts.id === id) this.#texts = { id, byView: { ...this.#texts.byView, ...texts } };
      else if (this.res?.id === id) this.#texts = { id, byView: texts }; // not if a newer response arrived first
    };
    const failed = (e: unknown) => `(${errorMessage(e)})`;
    const fetchText = (v: "raw" | "pretty") => api.responseBody(id, v).then((bytes) => new TextDecoder().decode(bytes));
    /** Fetches the raw text and keeps it as the text of each of `views`. */
    const keepRaw = (views: TextView[]) =>
      fetchText("raw").then(
        (raw) => keep(Object.fromEntries(views.map((v) => [v, raw]))),
        (e) => keep({ [view]: failed(e) }),
      );
    if (view === "hex") api.hexdump(id).then((hex) => keep({ hex }), (e) => keep({ hex: failed(e) }));
    else if (view === "raw") keepRaw(["raw"]);
    else fetchText("pretty").then((pretty) => keep({ pretty }), () => keepRaw(["raw", "pretty"]));
  }

  // The JSONPath filter runs in the core against the stored body, by response
  // id, so a re-send re-runs it on the new response. Only for whole JSON bodies;
  // otherwise the expression is kept for the next JSON response in this tab.

  readonly canFilter = $derived(!!this.res && this.kind === "json" && !this.res.truncated);
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
  /**
   * The editor's text is on its way: `"pretty"` for Pretty text being
   * formatted, `"text"` for the raw text or Hex dump; null when it's there (or
   * filter matches show instead). A re-sent response keeps showing the previous
   * one's text in the same view until its own arrives, so the editor doesn't
   * flash empty.
   */
  readonly loading = $derived.by<"pretty" | "text" | null>(() => {
    const view = this.#textView;
    if (this.filtered || !view || this.#texts.byView[view] !== undefined) return null;
    return view === "pretty" ? "pretty" : "text";
  });

  /** The editor's text: filter matches, else the fetched text of the view shown (the raw text behind a preview). */
  readonly text = $derived.by(() => {
    if (!this.res) return "";
    if (this.filtered) return this.filtered.text;
    return this.#texts.byView[this.#textView ?? "raw"] ?? "";
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
