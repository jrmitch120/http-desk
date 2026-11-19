// Text typed in a view of a document, rather than text rendered from it: a request's
// Source view (#163) or the file view, the whole file as one text (#166). One rule for
// both. The document stays authoritative: typed text is kept as typed at once and read
// by the core after a short pause, and text that parses replaces what it stands for (the
// request, or the document's file), so the document's other views follow; text that
// doesn't parse leaves that at its last valid state and reads as dirty until it's
// settled (`unparsed`: Save as written or Revert to last valid, #164).
//
// While a view holds text that doesn't parse, nothing else may change what that text
// stands for, or the text would stop standing for it and be dropped unseen (#174): the
// other views that could are read-only (`lock`), and the store refuses actions from
// outside the views that would (`blocked`: explorer Rename, Delete, Restore request,
// Rename variable, …), saying why. Typed text that parses never blocks anything.
import { untrack } from "svelte";
import { api, errorMessage } from "./api";
import { basename, displayName, uid } from "./http";
import { FileReader } from "./fileReader";
import { carryKeys } from "./reattach";
import { docSnapshot, fileShot, FileStamp, snapshot } from "./snapshots.svelte";
import { sharedEnds } from "./splice";
import type { Doc } from "./store.svelte";
import type { Tab } from "./tabView";
import type { BodyFile, Following, HttpFile, OpenText, ParsedRequest, PortabilityMark, Problem, Request } from "./types";

/** A view of a document that can hold typed text: request `key`'s Source view, or the document's file view. */
export type TextView = { kind: "request"; key: string } | { kind: "file" };

/** A document's file view. */
export const fileView: TextView = { kind: "file" };
/** Request `key`'s Source view. */
export const sourceView = (key: string): TextView => ({ kind: "request", key });

/** What a view holds once the user has typed in it. */
export interface TypedText {
  /** The text as typed (the latest keystroke; it's read after a short pause). */
  text: string;
  /** The problems the core found reading the text last read. */
  problems: Problem[];
  /** The files a Source view's request body reads, placed in the text (none for a file view). */
  files: BodyFile[];
  /** False while the text doesn't parse (no request line, or an error): what it stands
   *  for keeps its last valid state and reads as dirty. */
  parses: boolean;
}

/** A Source view's text and the request it goes with (a snapshot): once the request
 *  changes otherwise, the text no longer stands for it. */
export interface SourceEdit extends TypedText {
  request: string;
  /** What the parser recovered from the text last read (null: no request line): what
   *  Save as written saves while the text doesn't parse, with what follows its block. */
  recovered: Request | null;
  following: Following | null;
}

/** A file view's text and the file it goes with (`FileStamp`). */
export interface FileEdit extends TypedText {
  file: FileStamp;
  /** What the parser recovered from the text last read: what Save as written saves while the text doesn't parse. */
  recovered: HttpFile | null;
}

/** Text that doesn't parse in one of a document's views, and the two ways to settle it before the file is saved. */
export interface UnparsedText {
  /** What holds the text, for the dialog: the request's or the file's name. */
  name: string;
  /** What the last valid state is of. */
  noun: TextView["kind"];
  /** False when the parser recovered nothing to save (no request line): only Revert is offered. */
  canSaveAsWritten: boolean;
  /** The document takes what the parser recovered from the text, which is saved as the text, byte for byte. */
  saveAsWritten(): void;
  /** The text is dropped: the document stays at its last valid state, which is saved. */
  revert(): void;
}

/** Why a view is read-only (`TextViews.lock`): a view holds text that doesn't parse. */
export interface ViewLock {
  /** Says why, for the view's banner. */
  reason: string;
  /** The view holding the text. */
  heldBy: TextView;
}

/** How long typing in a view pauses before its text is read. */
export const TEXT_READ_DELAY_MS = 150;

/**
 * How long a view waits after its document changed otherwise (an edit in another view)
 * before it shows the change rendered, and after its own text changed before it asks
 * what the core finds in it: a little under a read, so another view's typing shows soon.
 */
export const VIEW_REFRESH_DELAY_MS = 120;

/**
 * Runs `task` after `ms` (`VIEW_REFRESH_DELAY_MS` by default) and gives what it finds to
 * `then`, unless the effect calling it runs again or ends meanwhile: call it from an
 * effect and return what it returns. How a view asks the core about its text once typing pauses.
 */
export function afterPause<T>(task: () => Promise<T>, then: (found: T) => void, ms = VIEW_REFRESH_DELAY_MS): () => void {
  let stale = false;
  const timer = setTimeout(async () => {
    const found = await task();
    if (!stale) then(found);
  }, ms);
  return () => {
    stale = true;
    clearTimeout(timer);
  };
}

/** Whether `parsed` text can replace a request: it has a request line and no error. */
export function sourceParses(parsed: ParsedRequest): parsed is ParsedRequest & { request: Request } {
  return parsed.request !== null && !parsed.problems.some((p) => p.severity === "error");
}

/** `doc`'s Source view text for `req`, while `req` is still as that text left it. */
export function sourceEdit(doc: Doc, req: Request, shot = docSnapshot(req)): SourceEdit | null {
  const edit = doc.sources[req._key!];
  return edit && edit.request === shot ? edit : null;
}

/** `doc`'s file view text, while the file is still as that text left it. */
export function fileEdit(doc: Doc): FileEdit | null {
  const edit = doc.fileText;
  return edit && edit.file.matches(doc.file) ? edit : null;
}

/** What the views need from the rest of the store. */
export interface TextViewsHost {
  readonly docs: Record<string, Doc>;
  /** A request of the document at `path`: in its file, or held by an Orphaned tab. */
  findRequest(path: string, key: string): Request | undefined;
  /** Requests `keys` of `path` are gone from its file (typed out of its file view): their tabs close, as deleting them does. */
  requestsGone(path: string, keys: Set<string>): void;
  toast(kind: "error", message: string): void;
}

/** Typed text waiting to be read: after a pause, or at once on Save or Send. */
interface Pending {
  path: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (() => void)[];
  read: () => Promise<void>;
}

const pendingId = (path: string, view: TextView) => (view.kind === "file" ? `${path}\nfile` : `${path}\nrequest\n${view.key}`);

/**
 * A request a file view's text put in a document, and its JSON then (`snapshot`): while it
 * still has that, it reads as its block's text does. One loaded or saved has its
 * document's `saved` JSON for that.
 */
const readAs = new WeakMap<Request, string>();

const ensureKey = (r: Request) => {
  if (!r._key) r._key = uid();
  return r._key;
};

export class TextViews {
  constructor(private readonly host: TextViewsHost) {}

  private pending = new Map<string, Pending>();
  /** Each document's reader of its file view's text, which reads only the `###` blocks an edit touched (#168). Gone with the document. */
  private readers = new WeakMap<Doc, FileReader>();

  /** The edit `view` of `doc` holds, while what it stands for is as it left it. */
  private current(doc: Doc, view: TextView): SourceEdit | FileEdit | null {
    if (view.kind === "file") return fileEdit(doc);
    const req = this.host.findRequest(doc.path, view.key);
    return req ? sourceEdit(doc, req) : null;
  }

  /**
   * The user typed `text` in `view` of the document at `path`. It's kept as typed at once
   * and read after a short pause (`TEXT_READ_DELAY_MS`). Settles once `text` is read, or
   * once later typing replaced it.
   */
  edit(path: string, view: TextView, text: string): Promise<void> {
    const doc = this.host.docs[path];
    if (!doc) return Promise.resolve();
    if (view.kind === "request") {
      const req = this.host.findRequest(path, view.key);
      if (!req) return Promise.resolve();
      const last = sourceEdit(doc, req);
      doc.sources[view.key] = { text, problems: last?.problems ?? [], files: last?.files ?? [], parses: last?.parses ?? true, request: snapshot(req), recovered: last?.recovered ?? null, following: last?.following ?? null };
    } else {
      // Typed on from text that still stands for the file: only the text changes, so
      // what reads whether the file is dirty or invalid doesn't run again for each keystroke.
      const last = fileEdit(doc);
      if (last) last.text = text;
      else doc.fileText = { text, problems: [], files: [], parses: true, file: FileStamp.of(doc.file), recovered: null };
    }
    return this.readLater(path, view, () => this.read(path, view, text));
  }

  /** What `view` of `path` holds when the user typed it: null when its text is rendered (nothing typed, or another edit since). */
  typed(path: string, view: TextView): TypedText | null {
    const doc = this.host.docs[path];
    return doc ? this.current(doc, view) : null;
  }

  /** Whether `view` of `path` holds text that doesn't parse. */
  isInvalid(path: string, view: TextView): boolean {
    return this.typed(path, view)?.parses === false;
  }

  /**
   * The text `view` shows: what the user typed, or what it stands for rendered by the
   * core (as written where it still matches its text). A file view's has `\n` line
   * breaks and no byte order mark (the file keeps its own), and in a file with mixed
   * endings, each line written with `\r\n` keeps it. Null without it.
   */
  async textFor(path: string, view: TextView): Promise<string | null> {
    const doc = this.host.docs[path];
    if (!doc) return null;
    const typed = this.current(doc, view);
    if (typed) return typed.text;
    if (view.kind === "file") return api.fileText({ ...($state.snapshot(doc.file) as HttpFile), lineEnding: "lf", bom: false });
    const req = this.host.findRequest(path, view.key);
    return req ? api.requestSource($state.snapshot(req) as Request) : null;
  }

  /** The file view's reader for `path`'s document. */
  private reader(path: string): FileReader {
    const doc = this.host.docs[path];
    if (!doc) return new FileReader(api);
    let reader = this.readers.get(doc);
    if (!reader) this.readers.set(doc, (reader = new FileReader(api)));
    return reader;
  }

  /**
   * What the core finds in `text`, shown in the file view of `path`: what it reads as (its
   * requests' blocks as written, so whatever is found in them can be placed in it), its
   * problems, and the lines that behave differently in VS Code or Rider. Read a block at a
   * time, as typed text is read into the document.
   */
  async findings(path: string, text: string): Promise<{ file: HttpFile | null; problems: Problem[]; portability: PortabilityMark[] }> {
    const reader = this.reader(path);
    const [parsed, portability] = await Promise.all([reader.parse(text), reader.portability(text)]);
    return { file: parsed.file, problems: parsed.problems, portability };
  }

  /** Reads typed `text` into what `view` stands for, unless more typing or another edit came since. */
  private async read(path: string, view: TextView, text: string) {
    let reading: Reading;
    try {
      reading = view.kind === "file" ? await this.readFile(path, text) : await readRequest(text);
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return;
    }
    const doc = this.host.docs[path];
    const edit = doc && this.current(doc, view);
    if (!doc || !edit || edit.text !== text) return;
    Object.assign(edit, reading.found);
    if (!edit.parses) return;
    if (view.kind === "file") {
      this.replaceFile(doc, reading.parsed as HttpFile);
      (edit as FileEdit).file = FileStamp.of(doc.file);
    } else {
      const req: Request = { ...(reading.parsed as Request), _key: view.key };
      putRequest(doc, req);
      (edit as SourceEdit).request = snapshot(req);
    }
  }

  private async readFile(path: string, text: string): Promise<Reading> {
    const { file, problems } = await this.reader(path).parse(text);
    const parses = !problems.some((p) => p.severity === "error");
    return { found: { problems, files: [], parses, recovered: parses ? null : file }, parsed: file };
  }

  /**
   * Reads typed text (`read`) after a short pause, unless more typing in the same view
   * comes first, or a Save or Send reads it at once (`readNow`). Settles once read, or
   * once later typing replaced it.
   */
  private readLater(path: string, view: TextView, read: () => Promise<void>): Promise<void> {
    const id = pendingId(path, view);
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
    // Text replaced before it was read settles when the text replacing it is read.
    const settle: (() => void)[] = pending?.settle ?? [];
    const done = new Promise<void>((s) => settle.push(s));
    let reading: Promise<void> | null = null;
    const entry: Pending = {
      path,
      settle,
      timer: setTimeout(() => void entry.read(), TEXT_READ_DELAY_MS),
      read: () => {
        clearTimeout(entry.timer);
        reading ??= read().finally(() => {
          if (this.pending.get(id) === entry) this.pending.delete(id);
          settle.forEach((s) => s());
        });
        return reading;
      },
    };
    this.pending.set(id, entry);
    return done;
  }

  /** Whether text typed in `view` of `path` is waiting to be read. */
  waiting(path: string, view: TextView): boolean {
    return this.pending.has(pendingId(path, view));
  }

  /** Reads now the text typed in `path`'s views (only `view`'s, if given) still waiting to be read. */
  async readNow(path: string, view?: TextView): Promise<void> {
    const waiting = view ? [this.pending.get(pendingId(path, view))].filter((e) => !!e) : [...this.pending.values()].filter((e) => e.path === path);
    await Promise.all(waiting.map((e) => e.read()));
  }

  /** Forgets the text typed in `view` of `path`, read or not. */
  drop(path: string, view: TextView) {
    const id = pendingId(path, view);
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.settle.forEach((s) => s());
    }
    const doc = this.host.docs[path];
    if (doc && view.kind === "file") doc.fileText = null;
    else if (doc && view.kind === "request") delete doc.sources[view.key];
  }

  /**
   * The text that doesn't parse in `path`'s views: each request's Source view whose text
   * doesn't, then the file view's. Answers apply in this order and each drops its text,
   * so where a request's source and the file view both hold some (typed in the moment
   * before either was read), the file view's answer is the one the file is saved with.
   */
  unparsed(path: string): UnparsedText[] {
    const doc = this.host.docs[path];
    if (!doc) return [];
    const sources = [...doc.file.requests, ...doc.orphans].flatMap((req): UnparsedText[] => {
      const edit = sourceEdit(doc, req);
      if (edit?.parses !== false) return [];
      const key = req._key!;
      const recovered = edit.recovered && ($state.snapshot(edit.recovered) as Request);
      const following = edit.following && ($state.snapshot(edit.following) as Following);
      return [
        {
          name: displayName(req),
          noun: "request",
          canSaveAsWritten: !!recovered,
          saveAsWritten: () => {
            this.drop(path, { kind: "request", key });
            const now = this.host.docs[path];
            if (now && recovered) putAsWritten(now, { ...recovered, _key: key }, following);
          },
          revert: () => this.drop(path, { kind: "request", key }),
        },
      ];
    });
    const edit = fileEdit(doc);
    if (edit?.parses !== false) return sources;
    const recovered = edit.recovered && ($state.snapshot(edit.recovered) as HttpFile);
    return [
      ...sources,
      {
        name: basename(path),
        noun: "file",
        canSaveAsWritten: !!recovered,
        saveAsWritten: () => {
          this.drop(path, { kind: "file" });
          const now = this.host.docs[path];
          if (now && recovered) this.replaceFile(now, recovered);
        },
        revert: () => this.drop(path, { kind: "file" }),
      },
    ];
  }

  /**
   * Why an action from outside the views can't change the file at `path` now (null: it
   * can): its file view holds text that doesn't parse, which stands for the whole file,
   * or (for an action on requests `keys`) one of those requests' Source view does.
   */
  blocked(path: string, keys: string[] = []): string | null {
    const doc = this.host.docs[path];
    if (!doc) return null;
    const name = basename(path);
    if (fileEdit(doc)?.parses === false) return `The text in ${name}'s file view doesn't parse, so ${name} can't be changed until it does`;
    for (const key of keys) {
      const req = this.host.findRequest(path, key);
      if (req && sourceEdit(doc, req)?.parses === false) return `The source of "${displayName(req)}" doesn't parse, so it can't be changed until it does`;
    }
    return null;
  }

  /**
   * Why `tab` is read-only now, or null when it can be edited: a view of its file holds
   * text that doesn't parse, which an edit here would stop standing for. A request tab is
   * while the file view does (the whole tab), or while its own source does (all but its
   * source); a file view is while any request's Source view does. Nothing is refused from opening.
   */
  lock(tab: Tab): ViewLock | null {
    const doc = this.host.docs[tab.path];
    if (!doc) return null;
    if (tab.kind === "request") {
      if (fileEdit(doc)?.parses === false)
        return {
          reason: `The text in ${basename(tab.path)}'s file view doesn't parse. Until it does, this request can't be edited here.`,
          heldBy: { kind: "file" },
        };
      const own = this.host.findRequest(tab.path, tab.key);
      if (own && sourceEdit(doc, own)?.parses === false)
        return { reason: "This request's source doesn't parse. Until it does, the request can be edited only in its source.", heldBy: { kind: "request", key: tab.key } };
      return null;
    }
    const held = doc.file.requests.find((r) => sourceEdit(doc, r)?.parses === false);
    if (!held) return null;
    return {
      reason: `The source of "${displayName(held)}" doesn't parse. Until it does, ${basename(tab.path)} can't be edited here.`,
      heldBy: { kind: "request", key: held._key! },
    };
  }

  /**
   * The document at `path` as its views have it, for the Problems panel: its file view's
   * text, or its file with each request whose Source view holds text that doesn't parse
   * as that text is written (what Save as written would save). Live state: reading it tracks it.
   */
  openText(path: string): OpenText | null {
    const doc = this.host.docs[path];
    if (!doc) return null;
    const typed = fileEdit(doc);
    if (typed) return { path, text: typed.text };
    const unparsed = doc.file.requests.flatMap((r) => {
      const edit = sourceEdit(doc, r);
      return edit?.parses === false && edit.recovered ? [[r._key!, edit] as const] : [];
    });
    if (!unparsed.length) return { path, file: doc.file };
    const file = { ...doc.file, requests: [...doc.file.requests], trailing: doc.file.trailing };
    for (const [key, edit] of unparsed) putAsWritten(file, { ...edit.recovered!, _key: key }, edit.following);
    return { path, file };
  }

  /**
   * What `openText(path)` follows, as strings that are the same while it's unchanged:
   * the file view's text, or the file (`fileShot`: its parts' JSON, which Svelte keeps,
   * so only an edited request's is made again) and the text of each Source view that
   * doesn't parse. Comparing them costs a pointer comparison per request.
   */
  openVersion(path: string): string[] {
    const doc = this.host.docs[path];
    if (!doc) return [];
    const typed = fileEdit(doc);
    if (typed) return [typed.text];
    const sources = doc.file.requests.flatMap((r) => {
      const edit = sourceEdit(doc, r);
      return edit?.parses === false ? [edit.text] : [];
    });
    const shot = fileShot(doc.file);
    return [shot.header, shot.rest, ...shot.requests, `${sources.length}`, ...sources];
  }

  /**
   * What `view` stands for as it is now (its request, or the file), null without it, and
   * whether it's still so. Reading it in an effect makes the effect run again whenever
   * that changes, for one comparison while it doesn't.
   */
  private standsFor(path: string, view: TextView): { still(): boolean } | null {
    const doc = this.host.docs[path];
    if (!doc) return null;
    if (view.kind === "file") {
      const stamp = FileStamp.of(doc.file);
      return { still: () => !!this.host.docs[path] && stamp.matches(this.host.docs[path].file) };
    }
    const req = this.host.findRequest(path, view.key);
    if (!req) return null;
    const shot = docSnapshot(req);
    return { still: () => this.host.findRequest(path, view.key) === req && docSnapshot(req) === shot };
  }

  /**
   * Keeps what `view` shows following its document; call it from an effect and return
   * what it returns. A change that came from the view itself (its typed text, read in)
   * shows that text as it is, at once, so the editor isn't touched and its cursor never
   * jumps. Any other change renders the text again (`textFor`) and shows it shortly
   * after (`VIEW_REFRESH_DELAY_MS`), or at once unless `soon`, unless it changed again
   * meanwhile. Typing itself doesn't rerun the effect: only what the view stands for changing does (#168).
   */
  follow(path: string, view: TextView, show: (text: string) => void, soon: boolean): (() => void) | undefined {
    const at = this.standsFor(path, view);
    if (!at) return;
    const typed = this.typed(path, view);
    if (typed) {
      const text = typed.text;
      untrack(() => show(text));
      return;
    }
    return afterPause(
      () => this.textFor(path, view).catch((e) => `# ${errorMessage(e)}`),
      (text) => text !== null && at.still() && show(text),
      soon ? VIEW_REFRESH_DELAY_MS : 0,
    );
  }

  /**
   * Puts `fresh` (read from the file view's text) in place of `doc`'s file. Each request
   * keeps its key where the edit left it (`carryKeys`), and its object where it's
   * unchanged; only the requests the edit changed are put in, so only what shows them is
   * updated. A request gone from the text closes its tabs, as deleting it does. The text
   * has no byte order mark of its own, and line endings only in a file with mixed ones
   * (where the view keeps each line's): otherwise the file's stay. `fresh` shares its
   * values with the reader's (`FileReader.parse`): what goes in is a copy.
   */
  private replaceFile(doc: Doc, fresh: HttpFile) {
    const old = doc.file.requests;
    const oldShots = fileShot(doc.file).requests;
    const oldShot = new Map(old.map((r, i) => [r, oldShots[i]]));
    const freshShots = new Map<Request, string>();
    const freshShot = (r: Request) => freshShots.get(r) ?? freshShots.set(r, snapshot(r)).get(r)!;
    // Whether the document's `a` reads as `b`, read from the text: at once when `a` is still
    // as it was read from the same block (most are), else by their JSON (#168).
    const same = (a: Request, b: Request) =>
      (a.raw !== null && a.raw === b.raw && a.leading === b.leading && oldShot.get(a) === (readAs.get(a) ?? doc.saved[a._key!])) || oldShot.get(a) === freshShot(b);
    const gone = carryKeys(old, fresh.requests, same);
    const byKey = new Map(old.map((r) => [r._key, r]));
    const added = new Set<number>();
    const requests = fresh.requests.map((r, i) => {
      const was = r._key ? byKey.get(r._key) : undefined;
      if (was && same(was, r)) return was;
      ensureKey(r);
      added.add(i);
      return structuredClone(r);
    });
    const { head, tail } = sharedEnds(old.length, requests.length, (i, j) => old[i] === requests[j]);
    if (head + tail < Math.max(old.length, requests.length)) old.splice(head, old.length - head - tail, ...requests.slice(head, requests.length - tail));
    // As put in (the document's own object for it).
    for (const i of added) readAs.set(old[i], freshShot(fresh.requests[i]));
    if (JSON.stringify(fresh.header) !== JSON.stringify(doc.file.header)) doc.file.header = structuredClone(fresh.header);
    doc.file.trailing = fresh.trailing;
    if (doc.file.mixedEndings) {
      doc.file.lineEnding = fresh.lineEnding;
      doc.file.mixedEndings = fresh.mixedEndings ?? false;
    }
    if (gone.size) this.host.requestsGone(doc.path, gone);
  }
}

/** What reading a view's text found, and what it read (a request, or a file). */
interface Reading {
  found: Pick<TypedText, "problems" | "files" | "parses"> & { recovered: Request | HttpFile | null; following?: Following | null };
  parsed: Request | HttpFile | null;
}

async function readRequest(text: string): Promise<Reading> {
  const parsed = await api.parseRequest(text);
  return { found: { problems: parsed.problems, files: parsed.files, parses: sourceParses(parsed), recovered: parsed.request, following: parsed.following }, parsed: parsed.request };
}

/** `req` replaces the request of `doc` (or its orphan) with the same key. */
function putRequest(doc: Doc, req: Request) {
  const at = doc.file.requests.findIndex((r) => r._key === req._key);
  if (at >= 0) doc.file.requests[at] = req;
  else doc.orphans = doc.orphans.map((r) => (r._key === req._key ? req : r));
}

/**
 * `req`, recovered from its Source view's text, replaces the request with its key in
 * `file` (a document's, or a copy), and what followed its block in the text goes right
 * after it, as new requests and the text before the next one, so the file is written
 * with the text byte for byte. An orphan's (not in the file) goes at the file's end.
 */
function putAsWritten(target: Doc | HttpFile, req: Request, following: Following | null) {
  const file = "file" in target ? target.file : target;
  const at = file.requests.findIndex((r) => r._key === req._key);
  if (at >= 0) file.requests[at] = req;
  else if ("file" in target) putRequest(target, req);
  if (!following) return;
  const after = at >= 0 ? at + 1 : file.requests.length;
  const added = following.requests.map((r) => ({ ...r, _key: uid() }));
  const next = file.requests[after];
  if (next) file.requests[after] = { ...next, leading: following.trailing + next.leading };
  else file.trailing = following.trailing + file.trailing;
  file.requests.splice(after, 0, ...added);
}
