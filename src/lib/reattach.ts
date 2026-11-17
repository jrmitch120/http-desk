// Finding requests again after their file was read anew: a reload after another
// editor changed the file, or a workspace opening with its Layout.
import type { Request } from "./types";

/** Identifies a request across reloads and searches: name + method + URL. */
export const signature = (name: string, method: string, url: string) => `${name}\u0000${method}\u0000${url}`;

/** A request known before the file was read again, by its key: its name
 *  (the `###` title), method and URL, and where it was in the file, if it was. */
export interface KnownRequest {
  key: string;
  name: string;
  method: string;
  url: string;
  position: number | null;
}

/**
 * Re-attaches `known` requests to `fresh` ones just read from the file, giving
 * each match the known request's key (`_key`): by name + method + URL, then by
 * name alone, then by position (a still-unmatched request takes the known one
 * that was at its index, unless that one was already claimed). Returns the keys
 * left unmatched.
 */
export function reattach(known: KnownRequest[], fresh: Request[]): Set<string> {
  const unused = new Map(known.map((k) => [k.key, k]));
  const sig = (r: { name: string; method: string; url: string }) => signature(r.name, r.method, r.url);
  const byName = (r: { name: string }) => r.name;
  for (const same of [sig, byName]) {
    for (const r of fresh) {
      if (r._key || (same === byName && !r.name)) continue;
      const match = [...unused.values()].find((k) => same(k) === same(r));
      if (match) {
        r._key = match.key;
        unused.delete(match.key);
      }
    }
  }
  for (const k of known) {
    const r = k.position === null ? undefined : fresh[k.position];
    if (r && !r._key && unused.has(k.key)) {
      r._key = k.key;
      unused.delete(k.key);
    }
  }
  return new Set(unused.keys());
}
