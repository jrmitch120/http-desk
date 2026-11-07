// Display helpers for the response viewer's Cookies tab. The parsing itself is
// in the core (httpdesk_core::cookies); this only turns fields into words.
import type { ResponseCookie } from "./types";

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
