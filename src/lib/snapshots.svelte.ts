// A document's requests and file as JSON, kept up to date by Svelte as they change, so
// asking again whether one changed costs a comparison (#168). What reads whether a
// document is dirty (the store) and whether typed text still stands for what it was
// typed for (textViews.svelte.ts) share them.
import type { HttpFile, Request } from "./types";

/** `req` as JSON, its key left out (only a request has one). No replacer function: one makes stringifying a file's requests several times slower. */
export function snapshot(req: Request): string {
  const { _key, ...rest } = req;
  return JSON.stringify(rest);
}

/**
 * `compute(of)`, kept up to date by Svelte as what it reads of `of` (a document's
 * state) changes: a derived per `of`, in `cache`. Reading it again costs nothing
 * until then, and every reader shares one computation. A file of a thousand
 * requests would otherwise be walked through, every property, on each check of
 * whether it's dirty, by each part of the window that shows it (#168).
 */
export function kept<K extends object, V>(cache: WeakMap<K, () => V>, of: K, compute: (of: K) => V): V {
  const known = cache.get(of);
  if (known) return known();
  // Made from a microtask, outside whatever reads it now (an effect, a derived): one
  // made inside would stop following `of` once that reader is destroyed.
  queueMicrotask(() => {
    if (!cache.has(of)) cache.set(of, keep(of, compute));
  });
  return compute(of);
}

function keep<K, V>(of: K, compute: (of: K) => V): () => V {
  const value = $derived(compute(of));
  return () => value;
}

const keptSnapshots = new WeakMap<Request, () => string>();

/** `snapshot` of `req`, a request of a document (its state, which Svelte sees change). */
export const docSnapshot = (req: Request): string => kept(keptSnapshots, req, snapshot);

/** A document's file as JSON, request keys left out: its header, each request's `docSnapshot`, and the rest. */
export interface FileShot {
  header: string;
  requests: string[];
  rest: string;
}

const keptFileShots = new WeakMap<HttpFile, () => FileShot>();

/** `file` (a document's state) as JSON: a new value only once something in it changed. */
export const fileShot = (file: HttpFile): FileShot =>
  kept(keptFileShots, file, (f) => ({
    header: JSON.stringify(f.header),
    requests: f.requests.map(docSnapshot),
    rest: JSON.stringify([f.trailing, f.lineEnding, f.mixedEndings ?? false, f.bom]),
  }));

/**
 * A document's file as it was when stamped (`fileShot`). Checking it against the
 * file costs one comparison while the file is unchanged, and the requests' strings
 * Svelte keeps after it changed. A class, so the document's state doesn't make it reactive.
 */
export class FileStamp {
  private constructor(private readonly shot: FileShot) {}

  /** `file`, a document's (its state). */
  static of(file: HttpFile): FileStamp {
    return new FileStamp(fileShot(file));
  }

  /** Whether `file` (a document's) is still as stamped. */
  matches(file: HttpFile): boolean {
    const now = fileShot(file);
    const then = this.shot;
    if (now === then) return true;
    return now.header === then.header && now.rest === then.rest && now.requests.length === then.requests.length && now.requests.every((s, i) => s === then.requests[i]);
  }
}
