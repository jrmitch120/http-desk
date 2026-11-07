// Response header tools for the Headers tab: the name filter, "Copy all" text,
// and hover explanations of well-known caching, CORS and rate-limit headers.

export type Header = [name: string, value: string];

/** Headers whose name contains `query` (case-insensitive, surrounding space ignored), in response order. */
export function filterHeaders(headers: Header[], query: string): Header[] {
  const q = query.trim().toLowerCase();
  if (!q) return headers;
  return headers.filter(([name]) => name.toLowerCase().includes(q));
}

/** "Copy all": one `Name: value` line per header, in response order, as a bug report or a `.http` file would have them. */
export function headersText(headers: Header[]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join("\n");
}

export type HeaderGroup = "Caching" | "CORS" | "Rate limit";

export interface HeaderExplanation {
  group: HeaderGroup;
  /** One or two plain sentences, shown in the name's tooltip. */
  text: string;
}

const caching = (text: string): HeaderExplanation => ({ group: "Caching", text });
const cors = (text: string): HeaderExplanation => ({ group: "CORS", text });
const rateLimit = (text: string): HeaderExplanation => ({ group: "Rate limit", text });

const limit = rateLimit("The number of requests allowed in the current window.");
const remaining = rateLimit("How many requests are left in the current window.");
const reset = rateLimit("When the window resets: usually seconds from now, or a Unix timestamp with some APIs.");

/**
 * Static table, keyed by lowercase name. Rate limits cover both the IETF
 * `RateLimit-*` fields and the widespread `X-RateLimit-*` convention.
 */
const EXPLANATIONS: Record<string, HeaderExplanation> = {
  "cache-control": caching(
    "Who may cache the response and for how long: max-age=N (seconds fresh), no-cache (revalidate before reuse), no-store (never store), private (browser only), public (shared caches too).",
  ),
  etag: caching("A version tag for this response. Send it back in If-None-Match to get 304 Not Modified when nothing changed."),
  expires: caching("The date after which the response is stale. Cache-Control max-age wins when both are present."),
  "last-modified": caching("When the resource last changed. Send it back in If-Modified-Since to get 304 Not Modified when nothing changed."),
  age: caching("Seconds the response has spent in a cache (a CDN or proxy). Present means it was served from a cache."),
  vary: caching("Request headers that change the response. Caches keep a separate copy for each combination of their values."),
  pragma: caching("Legacy HTTP/1.0 caching header; no-cache here means the same as Cache-Control: no-cache."),
  "access-control-allow-origin": cors("Which origin may read this response from browser JavaScript: one origin, or * for any."),
  "access-control-allow-methods": cors("The methods a browser may use for this resource, sent in reply to a CORS preflight (OPTIONS)."),
  "access-control-allow-headers": cors("The request headers a browser may send for this resource, sent in reply to a CORS preflight (OPTIONS)."),
  "access-control-allow-credentials": cors("true lets browser JavaScript send cookies and read the response. It can't be combined with Allow-Origin: *."),
  "access-control-expose-headers": cors("Response headers browser JavaScript may read, beyond the always-safe ones (Content-Type, Cache-Control…)."),
  "access-control-max-age": cors("Seconds a browser may cache this preflight result before sending another OPTIONS request."),
  ratelimit: rateLimit("The current rate limit: the quota left (r) and seconds until it resets (t), for the policy named."),
  "ratelimit-policy": rateLimit("The rate-limit policies that apply: the quota (q) per window of w seconds."),
  "ratelimit-limit": limit,
  "ratelimit-remaining": remaining,
  "ratelimit-reset": reset,
  "x-ratelimit-limit": limit,
  "x-ratelimit-remaining": remaining,
  "x-ratelimit-reset": reset,
  "retry-after": rateLimit("How long to wait before trying again, in seconds or as a date. Sent with 429 Too Many Requests and 503."),
};

/** What a well-known caching, CORS or rate-limit header means, or null for any other header. */
export function explainHeader(name: string): HeaderExplanation | null {
  return EXPLANATIONS[name.toLowerCase()] ?? null;
}
