// Display helpers for cookie tables: the response viewer's Cookies tab and the
// Session panel's Cookies section. The parsing itself is in the core
// (httpdesk_core::cookies); this only turns fields into words.
import type { ResponseCookie, StoredCookie } from "./types";

const UNITS: [seconds: number, unit: string][] = [
  [86400, "d"],
  [3600, "h"],
  [60, "min"],
];

/**
 * When a cookie expires, as the server wrote it: Max-Age (which wins over
 * Expires when both are set) in the largest whole unit, else the Expires date
 * in GMT like an HTTP date, else "Session".
 */
export function cookieExpiry(c: ResponseCookie): string {
  if (c.parseError !== null) return "";
  if (c.maxAge !== null) {
    if (c.maxAge <= 0) return "Expired (Max-Age 0)";
    const [size, unit] = UNITS.find(([s]) => c.maxAge! % s === 0) ?? [1, "s"];
    return `Max-Age ${c.maxAge / size} ${unit}`;
  }
  if (c.expires !== null) return new Date(c.expires).toUTCString();
  return "Session";
}

/** When a cookie in the Session's jar expires, as an HTTP date in GMT, else "Session". */
export function storedCookieExpiry(c: StoredCookie): string {
  return c.expires ? new Date(c.expires).toUTCString() : "Session";
}

/** One row of a cookie table (`CookieTable.svelte`), its attributes in words. */
export interface CookieRow {
  name: string;
  value: string;
  /** The host it is sent to: the Domain attribute, or for a host-only cookie the host that set it. */
  domain: string;
  /** Set without a Domain attribute: sent back only to `domain`. */
  hostOnly: boolean;
  path: string;
  expiry: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  /** The Set-Cookie header as received, if known (a tooltip on the name). */
  raw?: string;
  /** Why the Set-Cookie couldn't be read as a cookie; the row then shows `raw` instead. */
  parseError?: string | null;
}

/** A Set-Cookie a response carried, as a cookie table row. */
export function responseCookieRow(c: ResponseCookie): CookieRow {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? hostOf(c.url),
    hostOnly: c.domain === null,
    path: c.path ?? "",
    expiry: cookieExpiry(c),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    raw: c.raw,
    parseError: c.parseError,
  };
}

/** A cookie in the Session's jar, as a cookie table row. */
export function storedCookieRow(c: StoredCookie): CookieRow {
  return { ...c, expiry: storedCookieExpiry(c) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
