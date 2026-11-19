// The requests of a whole file's `.http` text (a file view): where each one is, what
// it's called, and which one a cursor position is in. Read from the `.http` tree
// (http.ts), which splits blocks on `###` the way the core does; a block is a request
// when it has a request line, so the requests come in the order of the file's.
import type { SyntaxNode, Tree } from "@lezer/common";
import { httpLineTree } from "./http";

/** A request in the text: the `n`th block with a request line. */
export interface RequestBlock {
  /** Its place among the text's requests (0-based): the file's request at that index, once the text is read. */
  index: number;
  /** Its block, from the start of its `###` line (or of the text) to the end of its last line, blank lines included. */
  from: number;
  to: number;
  /** Where it's shown from: its `###` line, else its request line. */
  start: number;
  /** As written, GET when the request line has none. */
  method: string;
  /** Its `###` title, else its `# @name`, else its method and URL (as `displayName` calls a request). */
  label: string;
}

/** The requests in `text`, in order. `tree`: the text's `.http` tree, if there is one already. */
export function requestBlocks(text: string, tree: Tree = httpLineTree(text)): RequestBlock[] {
  const out: RequestBlock[] = [];
  const slice = (n: SyntaxNode | null) => (n ? text.slice(n.from, n.to) : "");
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    if (block.name !== "Block") continue;
    const line = block.getChild("RequestLine");
    if (!line) continue;
    const separator = block.getChild("Separator");
    const method = slice(line.getChild("Method")) || "GET";
    const url = slice(line.getChild("Url"));
    const title = separator ? slice(separator).slice(3).trim() : "";
    const name = block
      .getChildren("Directive")
      .find((d) => slice(d.getChild("DirectiveName")) === "@name")
      ?.getChild("DirectiveValue");
    out.push({
      index: out.length,
      from: block.from,
      to: block.to,
      start: (separator ?? line).from,
      method,
      label: title || slice(name ?? null) || (url ? `${method} ${url}` : "Untitled request"),
    });
  }
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
