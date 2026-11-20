// The requests of a whole file's `.http` text (a file view): where each one is, what
// it's called, and which one a cursor position is in. Read from the `.http` tree
// (http.ts), which splits blocks on `###` the way the core does; a block is a request
// when it has a request line, so the requests come in the order of the file's.
import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { httpLineTree } from "./http";

/** What the outline shows of a request. The same object while its block's text is the same (#168). */
export interface OutlineEntry {
  /** As written, GET when the request line has none. */
  method: string;
  /** Its `###` title, else its `# @name`, else its method and URL (as `displayName` calls a request). */
  label: string;
}

/** A request in the text: the `n`th block with a request line. */
export interface RequestBlock extends OutlineEntry {
  /** Its place among the text's requests (0-based): the file's request at that index, once the text is read. */
  index: number;
  /** Its block, from the start of its `###` line (or of the text) to the end of its last line, blank lines included. */
  from: number;
  to: number;
  /** Where it's shown from: its `###` line, else its request line. */
  start: number;
  entry: OutlineEntry;
}

/** A block's request, read once per block tree: an editor's tree keeps the trees of the blocks an edit didn't touch. */
interface BlockRequest {
  entry: OutlineEntry;
  /** Where it's shown from, from the block's start. */
  start: number;
}
const read = new WeakMap<Tree, BlockRequest | null>();

/** The request of `block`, in `text`; null when it has no request line. */
function blockRequest(block: SyntaxNode, text: string | Text): BlockRequest | null {
  const line = block.getChild("RequestLine");
  if (!line) return null;
  const slice = (n: SyntaxNode | null | undefined) => (!n ? "" : typeof text === "string" ? text.slice(n.from, n.to) : text.sliceString(n.from, n.to));
  const separator = block.getChild("Separator");
  const method = slice(line.getChild("Method")) || "GET";
  const url = slice(line.getChild("Url"));
  const title = separator ? slice(separator).slice(3).trim() : "";
  const name = block
    .getChildren("Directive")
    .find((d) => slice(d.getChild("DirectiveName")) === "@name")
    ?.getChild("DirectiveValue");
  return { entry: { method, label: title || slice(name) || (url ? `${method} ${url}` : "Untitled request") }, start: (separator ?? line).from - block.from };
}

/**
 * The requests in `text`, in order. `tree`: the text's `.http` tree, if there is one
 * already (an editor's): each block it kept from before an edit is read as it was.
 */
export function requestBlocks(text: string | Text, tree: Tree = httpLineTree(text.toString())): RequestBlock[] {
  const out: RequestBlock[] = [];
  // A cursor, not a node per block: most blocks are only looked up.
  const block = tree.cursor();
  if (!block.firstChild()) return out;
  do {
    if (block.name !== "Block") continue;
    const own = block.tree;
    let found = own ? read.get(own) : undefined;
    if (found === undefined) {
      found = blockRequest(block.node, text);
      if (own) read.set(own, found);
    }
    if (found) out.push({ index: out.length, from: block.from, to: block.to, start: block.from + found.start, ...found.entry, entry: found.entry });
  } while (block.nextSibling());
  return out;
}

/** The request `pos` is in (on its `###` line, request line, headers, body, handler or the blank lines after it), if any. */
export function requestAt(blocks: readonly RequestBlock[], pos: number): RequestBlock | null {
  // Blocks are in order: the last one starting at or before `pos`.
  let lo = 0;
  let hi = blocks.length - 1;
  let found: RequestBlock | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].from <= pos) {
      found = blocks[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found && pos <= found.to ? found : null;
}
