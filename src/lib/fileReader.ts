// Reading a file view's text (#168) a `###` block at a time. The core reads each
// block of a file on its own (crates/httpdesk-text/src/parser.rs, `split_blocks`):
// a block is a request, or text that goes before the next one (its `leading`), and
// the first block, before any `###`, is the file's header when it isn't a request.
// So a block's reading depends only on its text, and an edit needs only the blocks
// it touched read again: the rest are as the core read them last time. Put together,
// the result is what the core gives for the whole text, problems and all.
import type { FileHeader, ParsedFile, PortabilityMark, Problem, Request } from "./types";

/** The core's text commands this needs (`api` has them). */
export interface TextCore {
  parseFileText(text: string): Promise<ParsedFile>;
  portabilityText(text: string): Promise<PortabilityMark[]>;
}

/**
 * More blocks than this to read and the whole text goes to the core at once: one
 * call instead of many (opening a file, a large paste, Replace all).
 */
const BLOCKS_READ_ONE_BY_ONE = 8;

/** A `###` block of the text, and the lines before it. */
interface Block {
  text: string;
  /** How many lines of the text come before the block. */
  linesBefore: number;
}

/** What the core read in a block, its lines counted from the block's first. */
interface BlockParse {
  /** Its request (its `leading` empty: that's the text before it, read in context). */
  request: Request | null;
  /** The file's header, for a first block that isn't a request. */
  header: FileHeader | null;
  problems: Problem[];
}

/** A file's header when its text starts with `###` (the core's `FileHeader::default()`). */
const NO_HEADER: FileHeader = { comments: [], variables: [], raw: null };

/** The byte order mark the core strips (and reads into `bom`). */
const BOM = "\u{FEFF}";

/** `text` split as the core splits it: block 0 is the text before the first `###` line (maybe empty), every other block starts with one. */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let start = 0;
  let linesBefore = 0;
  let lines = 0;
  for (let at = 0; at < text.length; ) {
    const end = text.indexOf("\n", at);
    if (text.startsWith("###", at)) {
      blocks.push({ text: text.slice(start, at), linesBefore });
      start = at;
      linesBefore = lines;
    }
    if (end < 0) break;
    lines++;
    at = end + 1;
  }
  blocks.push({ text: text.slice(start), linesBefore });
  return blocks;
}

/** Text the core reads specially as a whole (line endings it normalizes, a byte order mark): read in one go. */
const readWhole = (text: string) => text.includes("\r") || text.startsWith(BOM);

/**
 * What the core found in each block, by its text, kept from the last two reads:
 * a file's reading and the reading of the text before or after it can interleave
 * (the store and the file view read the same file).
 */
class BlockCache<T> {
  private current = new Map<string, T>();
  private previous = new Map<string, T>();

  get(block: string): T | undefined {
    return this.current.get(block) ?? this.previous.get(block);
  }

  /** Keeps `found` for the blocks of the text just read, and drops what the read before last used. */
  keep(found: Map<string, T>) {
    this.previous = this.current;
    this.current = found;
  }
}

/**
 * Reads a file view's text as the core would read it whole, sending the core only
 * the blocks it hasn't read yet. One per file: it remembers the blocks of the
 * texts it last read.
 */
export class FileReader {
  private parses = new BlockCache<BlockParse>();
  private marks = new BlockCache<PortabilityMark[]>();

  constructor(private core: TextCore) {}

  /**
   * The file and problems in `text`: what the core's `parse_file_text` gives. The
   * requests' nested values are shared with later readings: copy one before changing it.
   */
  async parse(text: string): Promise<ParsedFile> {
    if (readWhole(text)) return this.core.parseFileText(text);
    const blocks = splitBlocks(text);
    const found = await this.read(text, blocks, this.parses, (t) => this.core.parseFileText(t), parsesOf, ({ file, problems }) => ({
      request: file.requests[0] ?? null,
      header: file.requests.length ? null : file.header,
      problems,
    }));
    const file: ParsedFile["file"] = { header: NO_HEADER, requests: [], trailing: "", lineEnding: "lf", mixedEndings: false, bom: false };
    const problems: Problem[] = [];
    let pending = "";
    blocks.forEach((block, i) => {
      if (!block.text) return;
      const { request, header, problems: own } = found.get(block.text)!;
      if (request) {
        file.requests.push({ ...request, leading: pending });
        pending = "";
        problems.push(...own.map((p) => ({ ...p, line: p.line + block.linesBefore })));
      } else if (i === 0) file.header = header!;
      else pending += block.text;
    });
    file.trailing = pending;
    return { file, problems };
  }

  /** The lines of `text` that behave differently in VS Code or Rider: what the core's `portability_text` gives. */
  async portability(text: string): Promise<PortabilityMark[]> {
    if (readWhole(text)) return this.core.portabilityText(text);
    const blocks = splitBlocks(text);
    const found = await this.read(text, blocks, this.marks, (t) => this.core.portabilityText(t), marksOf, (marks) => marks);
    return blocks.flatMap((b) => (b.text ? found.get(b.text)!.map((m) => ({ ...m, line: m.line + b.linesBefore })) : []));
  }

  /**
   * What the core finds in each of `blocks` (`text`, split): from `cache`, else read,
   * one block at a time (`readOne`), or with many to read the whole text at once,
   * split up (`split`).
   */
  private async read<Whole, T>(
    text: string,
    blocks: Block[],
    cache: BlockCache<T>,
    call: (text: string) => Promise<Whole>,
    split: (whole: Whole, blocks: Block[]) => Map<string, T>,
    readOne: (whole: Whole) => T,
  ): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    const missing = new Set<string>();
    for (const block of blocks) {
      const known = cache.get(block.text);
      if (known) found.set(block.text, known);
      else if (block.text) missing.add(block.text);
    }
    if (missing.size > BLOCKS_READ_ONE_BY_ONE) {
      split(await call(text), blocks).forEach((v, block) => found.set(block, v));
    } else {
      const read = await Promise.all([...missing].map(async (block) => [block, readOne(await call(block))] as const));
      read.forEach(([block, v]) => found.set(block, v));
    }
    cache.keep(found);
    return found;
  }
}

/** The whole text's reading, per block: each request is its block (`raw`), problems go by line. */
function parsesOf({ file, problems }: ParsedFile, blocks: Block[]): Map<string, BlockParse> {
  const out = new Map<string, BlockParse>();
  let next = 0;
  blocks.forEach((block, i) => {
    if (!block.text) return;
    const req = file.requests[next];
    const isRequest = req?.raw === block.text;
    if (isRequest) next++;
    const end = blocks[i + 1]?.linesBefore ?? Infinity;
    const own = isRequest ? problems.filter((p) => p.line > block.linesBefore && p.line <= end).map((p) => ({ ...p, line: p.line - block.linesBefore })) : [];
    out.set(block.text, {
      request: isRequest ? { ...req, leading: "" } : null,
      header: !isRequest && i === 0 ? file.header : null,
      problems: own,
    });
  });
  return out;
}

/** The whole text's portability marks, per block, by line. */
function marksOf(marks: PortabilityMark[], blocks: Block[]): Map<string, PortabilityMark[]> {
  const out = new Map<string, PortabilityMark[]>();
  blocks.forEach((block, i) => {
    const end = blocks[i + 1]?.linesBefore ?? Infinity;
    out.set(
      block.text,
      marks.filter((m) => m.line > block.linesBefore && m.line <= end).map((m) => ({ ...m, line: m.line - block.linesBefore })),
    );
  });
  return out;
}
