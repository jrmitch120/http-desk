// What the core and the shell found in each open request's source, kept so the
// check strip (computed synchronously, src/lib/checks.ts) and the Source view's
// underlines can read it: the core's reading of the request (`request_problems`),
// asked when the request is opened and after each edit, and whether each body file
// it reads exists (`body_file_exists`), asked when the request is opened and when
// the reference changes. Each is unknown until answered, and isn't flagged then.
import { api } from "./api";
import { dirname } from "./http";
import type { Request, RequestProblems } from "./types";

/** A reading of a request's source, and the request (as JSON) it read. */
export interface Reading {
  snap: string;
  read: RequestProblems;
}

/** The questions it asks: the shell's, or a test's. */
export interface Asker {
  requestProblems: (request: Request) => Promise<RequestProblems>;
  bodyFileExists: (file: string, path: string) => Promise<boolean>;
}

export class SourceProblems {
  /** Per request key, the latest reading. */
  private reads = $state<Record<string, Reading>>({});
  /** Per body file (the `.http` file's folder, then the path as written), whether it exists. */
  private files = $state<Record<string, boolean>>({});
  /** Per request key, the request (as JSON) last asked about, so an older reading answering late is dropped. */
  private asking = new Map<string, string>();

  constructor(private ask: Asker = api) {}

  /** Request `key`'s latest reading: of an earlier version of it while a newer one is asked about. */
  read(key: string): Reading | undefined {
    return this.reads[key];
  }

  /** Asks the core to read request `key` as `req` is now. Errors leave the last reading. */
  async refresh(key: string, req: Request): Promise<void> {
    const snap = JSON.stringify(req);
    this.asking.set(key, snap);
    try {
      const read = await this.ask.requestProblems(JSON.parse(snap));
      if (this.asking.get(key) === snap) this.put(key, snap, read);
    } catch {
      // The strip keeps what it had; nothing is flagged that wasn't.
    }
  }

  /**
   * Sets request `key`'s reading (`read`, of the request as `snap`) directly: the
   * seam for a reading found elsewhere, such as a live edit of the source parsed
   * with its problems (#163). Drops a `refresh` still under way.
   */
  put(key: string, snap: string, read: RequestProblems) {
    this.asking.set(key, snap);
    this.reads[key] = { snap, read };
  }

  /** Whether body file `path` (variables resolved) of `.http` file `file` exists, as last answered. */
  exists(file: string, path: string): boolean | undefined {
    return this.files[fileKey(file, path)];
  }

  /** Asks the shell whether body file `path` of `.http` file `file` exists, and keeps the answer. */
  async check(file: string, path: string): Promise<void> {
    try {
      this.files[fileKey(file, path)] = await this.ask.bodyFileExists(file, path);
    } catch {
      // Unknown, so not flagged.
    }
  }
}

const fileKey = (file: string, path: string) => `${dirname(file)}\n${path}`;

export const sourceProblems = new SourceProblems();
