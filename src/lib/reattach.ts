// Finding requests again after their file was read anew: a reload after another
// editor changed the file, a workspace opening with its Layout, or a search result.
import type { Request } from "./types";
import { sharedEnds } from "./splice";

/** How a request is found again: its name (the `###` title), method and URL as written. */
export interface RequestIdentity {
  name: string;
  method: string;
  url: string;
}

/** A request's identity and where it was in its file (its index), if it was. */
export interface PlacedRequest extends RequestIdentity {
  position: number | null;
}

/** Identifies a request across reloads and searches: name + method + URL. */
export const signature = (r: RequestIdentity) => `${r.name}\u0000${r.method}\u0000${r.url}`;

/** A request known before the file was read again, by its key. */
export interface KnownRequest extends PlacedRequest {
  key: string;
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
  const byName = (r: { name: string }) => r.name;
  for (const same of [signature, byName]) {
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

/**
 * Gives `fresh` requests, read from a file view's text, the keys of the `old` ones
 * (the document's) they stand for, as an edit to the text leaves them: the requests
 * before and after the edited part are as they were (`same`), and each keeps its
 * key; in between they're found as `reattach` finds them (by name + method + URL,
 * by name, by position). A request still unmatched takes the key of one of `before`
 * (requests an earlier edit removed) it stands for. Returns the old keys left unmatched.
 */
export function carryKeys(old: Request[], fresh: Request[], same: (a: Request, b: Request) => boolean, before: Request[] = []): Set<string> {
  const { head, tail } = sharedEnds(old.length, fresh.length, (i, j) => same(old[i], fresh[j]));
  for (let i = 0; i < head; i++) fresh[i]._key = old[i]._key;
  for (let i = 1; i <= tail; i++) fresh[fresh.length - i]._key = old[old.length - i]._key;
  const known = old.slice(head, old.length - tail).map((r, position) => ({ key: r._key!, name: r.name, method: r.method, url: r.url, position }));
  const between = fresh.slice(head, fresh.length - tail);
  const gone = reattach(known, between);
  // What's still new may be a request typed out earlier, back again: by name + method + URL, or by name.
  if (before.length) reattach(before.map((r) => ({ key: r._key!, name: r.name, method: r.method, url: r.url, position: null })), between);
  return gone;
}
