// The state behind a response's Body tab: which view the body shows, the
// editor document built for it (raw, Pretty JSON/XML, the Hex dump), the
// JSONPath filter and its matches, and the shape summary key completion uses.
// The response viewer owns one per mounted viewer, so the filter's matches
// outlive a switch to another viewer tab (the status bar's Copy copies them);
// the documents are kept per editor tab (responseDocs), so nothing is fetched
// or built twice for the same response.

import { untrack } from "svelte";
import type { Text } from "@codemirror/state";
import { api, errorMessage } from "./api";
import { buildDoc, longestLine, textDoc } from "./codemirror/docBuilder";
import type { Language } from "./codemirror/setup";
import { canUnwrap } from "./codemirror/unwrap";
import { keptDoc, keptPreview, loadDoc, loadPreview, type DocView, type Preview } from "./responseDocs";
import { nextTask } from "./timeSlices";
import type { FilterResult, HttpResponse, JsonShape, ResponseKind } from "./types";

export type BodyMode = "pretty" | "raw" | "preview";

/**
 * Lines longer than this are drawn in part when wrapped (CodeMirror's line
 * gaps), the rest estimated as full rows of text.
 */
const LONG_LINE = 20_000;

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
  /** The editor tab, whose documents are kept for it. */
  tabId: string;
  res: HttpResponse | undefined;
  mode: BodyMode;
  /** The filter expression as typed. */
  filter: string;
}

export class BodyView {
  /** Set by the constructor, before anything reads it (the derived values below are lazy). */
  #input: () => BodyViewInput = () => ({ tabId: "", res: undefined, mode: "pretty", filter: "" });

  /** Call during component set-up: the loaders are effects of the calling component. */
  constructor(input: () => BodyViewInput) {
    this.#input = input;
    $effect(() => this.#loadDoc());
    $effect(() => this.#runFilter());
    $effect(() => this.#loadPreview());
    $effect(() => () => void (this.#destroyed = true));
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
  // response's content type. Made once per tab and response, when Preview is
  // first shown, and kept per tab (responseDocs), so switching tabs and back
  // shows it again without fetching it. A re-sent response's preview keeps
  // showing the previous one until its own URL is made. A URL is revoked when
  // the tab's preview is replaced, or the tab releases its response (closed,
  // replaced, or gone with the workspace).

  /** The preview shown (or why the bytes couldn't be fetched), for the response it was made for. */
  #preview = $state.raw<({ id: string; kind: ResponseKind } & Preview) | null>(null);
  /** The `blob:` URL Preview shows (the previous response's while this one's is made, if it's the same kind); null until there's one. */
  readonly previewUrl = $derived(this.#preview?.kind === this.kind ? (this.#preview.url ?? null) : null);
  /** Why this response's bytes couldn't be fetched for Preview. */
  readonly previewError = $derived(this.#preview?.id === this.res?.id ? (this.#preview?.error ?? null) : null);

  #loadPreview() {
    const res = this.res;
    if (!res || !this.showingPreview) return;
    const { id } = res;
    const { tabId } = this.#input();
    if (untrack(() => this.#preview?.id === id)) return;
    const { kind } = this;
    const show = (preview: Preview) => {
      if (!this.#destroyed && this.res?.id === id) this.#preview = { id, kind, ...preview };
    };
    const kept = keptPreview(tabId, id);
    if (kept) return show(kept);
    const type = res.contentType ?? "application/octet-stream";
    void loadPreview(tabId, id, () =>
      api.responseBody(id, "bytes").then(
        (bytes) => ({ url: URL.createObjectURL(new Blob([bytes], { type })) }),
        (e) => ({ error: `(${errorMessage(e)})` }),
      ),
    ).then(show);
  }

  /** Set once the viewer is gone, so a preview made afterwards isn't shown by it. */
  #destroyed = false;

  // The editor's document, fetched from the shell by response id (never taken
  // from the send reply): the raw text or the Pretty JSON/XML from its lossless
  // formatter (numbers and text stay as the server sent them), as UTF-8 bytes
  // built into the document here in pieces, or the Hex view of a binary body.
  // Each is fetched and built once per tab and response, and only when its
  // view is shown, with "Preparing…" meanwhile; the documents are kept per tab
  // (responseDocs), so a remounted viewer shows them at once. If the body has
  // no Pretty text (it doesn't parse), Pretty shows the raw text; if it's no
  // longer stored, the editor says so.

  /** The document the editor shows for the current view; null while the body shows as a preview. */
  readonly #docView = $derived.by<DocView | null>(() => {
    if (!this.res) return null;
    if (this.isBinary) return this.effectiveMode === "preview" ? null : "hex";
    if (this.effectiveMode === "preview") return null;
    return this.effectiveMode === "pretty" && this.canPretty ? "pretty" : "raw";
  });
  /** The kept document of the view shown (the raw one behind a preview), as a remounted viewer first finds it. */
  readonly #kept = $derived.by(() => {
    const res = this.res;
    return res ? keptDoc(this.#input().tabId, this.#docView ?? "raw", res.id) : undefined;
  });
  /** The document last built (or found) for this viewer, which stays up while a re-sent response's is prepared. */
  #shown = $state.raw<{ view: DocView; doc: Text } | null>(null);

  #loadDoc() {
    const res = this.res;
    const view = this.#docView;
    const { tabId } = this.#input();
    if (!res || !view) return;
    const { id } = res;
    const failed = (e: unknown) => textDoc(`(${errorMessage(e)})`);
    const fetchDoc = (v: "raw" | "pretty") => api.responseBody(id, v).then((bytes) => buildDoc(bytes, nextTask));
    const raw = () => loadDoc(tabId, "raw", id, () => fetchDoc("raw").catch(failed));
    const loaded =
      view === "hex"
        ? loadDoc(tabId, "hex", id, () => api.hexdump(id).then(textDoc, failed))
        : view === "raw"
          ? raw()
          : loadDoc(tabId, "pretty", id, () => fetchDoc("pretty").catch(raw));
    loaded.then((doc) => {
      if (this.res?.id === id) this.#shown = { view, doc }; // not if a newer response arrived first
    });
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
  readonly #filteredDoc = $derived(this.filtered ? textDoc(this.filtered.text) : null);
  /**
   * The editor's document: filter matches, else the document of the view
   * shown (the raw one behind a preview). Null while it's fetched and built
   * ("Preparing…"), except that a re-sent response keeps showing the previous
   * one's document in the same view until its own is ready, so the editor
   * doesn't flash empty.
   */
  readonly doc = $derived.by<Text | null>(() => {
    if (!this.res) return null;
    if (this.#filteredDoc) return this.#filteredDoc;
    const view = this.#docView ?? "raw";
    return this.#kept ?? (this.#shown?.view === view ? this.#shown.doc : null);
  });
  /**
   * Whether the document has lines CodeMirror draws only in part when wrapped
   * (a minified body), which then break at any character: broken at
   * punctuation, a row holds less than CodeMirror estimates, so the line grows
   * as it's scrolled and its end can't be reached. Other text breaks between words.
   */
  readonly longLines = $derived(!!this.doc && longestLine(this.doc) > LONG_LINE);
  /**
   * Whether the document may be shown unwrapped: no line too long for
   * CodeMirror to draw that way (unwrap.ts). Otherwise it's shown wrapped,
   * whatever the tab's wrap choice, which is kept for the other views.
   */
  readonly canUnwrap = $derived(!this.doc || canUnwrap(this.doc));

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
