// Completion in `.http` source: what's offered depends on where the caret is,
// read the way the core's parser reads the text.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { http } from "./http";
import { accepting, httpCompletion } from "./httpCompletion";
import { KNOWN_DIRECTIVES } from "../http";
import rust from "../../../crates/httpdesk-text/src/parser.rs?raw";

/**
 * What completing at the `‸` in `text` offers: the text it would replace
 * (`typed`) and the labels, or null when nothing is offered.
 */
function complete(text: string, explicit = false, language = [http()]): { typed: string; labels: string[] } | null {
  const pos = text.indexOf("‸");
  if (pos < 0) throw new Error("no ‸ in the text");
  const doc = text.slice(0, pos) + text.slice(pos + 1);
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: language });
  const result = httpCompletion(new CompletionContext(state, pos, explicit));
  return result && { typed: doc.slice(result.from, pos), labels: result.options.map((o) => o.label) };
}

it("offers nothing outside a .http editor (a plain text field, a JSON body)", () => {
  expect(complete("GET https://example.com\nCont‸", true, [])).toBeNull();
  expect(complete("P‸", true, [json()])).toBeNull();
});

describe("header names", () => {
  it("offers the header names the Headers table suggests, matched the same way, replacing what's typed", () => {
    // As e2e/header-suggestions.spec.ts: names starting with the text, then names containing it.
    const r = complete("GET https://example.com\nCont‸");
    expect(r).toEqual({ typed: "Cont", labels: ["Content-Type", "Content-Length", "Cache-Control"] });
  });

  it("completes the name of a header already written, below other headers and comments", () => {
    expect(complete("GET https://example.com\nAccept: */*\n# a note\nUser‸: x\n")).toEqual({ typed: "User", labels: ["User-Agent"] });
  });

  it("offers every name on an empty header line only when asked", () => {
    expect(complete("GET https://example.com\n‸", true)?.labels).toHaveLength(20);
    expect(complete("GET https://example.com\n‸")).toBeNull();
  });

  it("offers nothing in a header's value", () => {
    expect(complete("GET https://example.com\nAccept: Con‸\n")).toBeNull();
  });
});

describe("no completion in a body or a script", () => {
  it("offers nothing in a body, after the blank line that ends the headers", () => {
    expect(complete("POST https://example.com\nContent-Type: text/plain\n\nCont‸\n")).toBeNull();
    expect(complete('POST https://example.com\nContent-Type: application/json\n\n{\n  "Cont‸": 1\n}\n')).toBeNull();
  });

  it("offers nothing in a pre-request script, a response handler or below one", () => {
    expect(complete("< {%\n  P‸\n%}\nGET https://example.com\n")).toBeNull();
    expect(complete("GET https://example.com\n\n> {%\n  P‸\n%}\n")).toBeNull();
    expect(complete("GET https://example.com\n\n> {%\n  client.log(1)\n%}\nCont‸")).toBeNull();
  });
});

describe("methods", () => {
  it("offers methods at the start of a request line", () => {
    expect(complete("P‸")).toEqual({ typed: "P", labels: ["POST", "PUT", "PATCH", "OPTIONS"] });
    expect(complete("### Add a pet\n# @name add\npa‸ https://example.com/pets\n")).toEqual({ typed: "pa", labels: ["PATCH"] });
  });

  it("offers nothing once the method is written, or in the URL", () => {
    expect(complete("GET ‸")).toBeNull();
    expect(complete("GET https://example.com/po‸")).toBeNull();
  });
});

describe("directives", () => {
  it("offers the directives the parser knows after `# @` or `// @` above the request line", () => {
    const r = complete("# @‸\nGET https://example.com\n");
    expect(r?.typed).toBe("");
    expect(r?.labels).toContain("name");
    expect(r?.labels).toContain("no-cookie-jar");
    expect(complete("###\n//@no-c‸\nGET https://example.com\n")).toEqual({ typed: "no-c", labels: ["no-cookie-jar"] });
    // A block that has no request line yet is all preamble.
    expect(complete("# @tim‸")?.labels).toEqual(["timeout", "connection-timeout"]);
  });

  it("offers nothing in a comment that isn't a directive, or below the request line", () => {
    expect(complete("#   @‸\nGET https://example.com\n")).toBeNull();
    expect(complete("# see @‸\nGET https://example.com\n")).toBeNull();
    expect(complete("GET https://example.com\n# @‸\n")).toBeNull();
  });
});

describe("the directive list", () => {
  it("is the parser's KNOWN_DIRECTIVES (crates/httpdesk-text/src/parser.rs)", () => {
    const constant = (name: string) => new RegExp(`const ${name}: &str = "([^"]+)"`).exec(rust)![1];
    const list = /const KNOWN_DIRECTIVES: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)![1];
    const known = list
      .split("\n")
      .map((l) => l.replace(/\/\/.*/, "").trim().replace(/,$/, ""))
      .filter(Boolean)
      .map((item) => (item.startsWith('"') ? item.slice(1, -1) : constant(item)));
    expect(known.length).toBeGreaterThan(10);
    expect([...KNOWN_DIRECTIVES].sort()).toEqual(known.sort());
  });
});

describe("accepting an option", () => {
  /** `text` (caret at `‸`) after `value` is accepted there, followed by `then`. */
  function accept(text: string, value: string, then: string): string {
    const pos = text.indexOf("‸");
    const doc = text.slice(0, pos) + text.slice(pos + 1);
    const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [http()] });
    const result = httpCompletion(new CompletionContext(state, pos, true))!;
    expect(result.options.map((o) => o.label)).toContain(value);
    const next = state.update(accepting(state, result.from, pos, value, then)).state;
    const at = next.selection.main.head;
    return next.doc.sliceString(0, at) + "‸" + next.doc.sliceString(at);
  }

  it("a header name is followed by its colon, and a method by a space", () => {
    expect(accept("GET https://example.com\nCont‸", "Content-Type", ": ")).toBe("GET https://example.com\nContent-Type: ‸");
    expect(accept("P‸", "POST", " ")).toBe("POST ‸");
  });

  it("what's there already isn't doubled, and the rest of the word goes", () => {
    expect(accept("GET https://example.com\nUser‸: x\n", "User-Agent", ": ")).toBe("GET https://example.com\nUser-Agent: ‸x\n");
    expect(accept("pa‸ https://example.com", "PATCH", " ")).toBe("PATCH ‸https://example.com");
    expect(accept("GET https://example.com\nAcc‸ept:", "Accept", ": ")).toBe("GET https://example.com\nAccept:‸");
  });

  it("a directive says which editor reads it, when only one does", () => {
    const pos = "# @‸".indexOf("‸");
    const state = EditorState.create({ doc: "# @\nGET https://example.com\n", selection: { anchor: pos }, extensions: [http()] });
    const details = Object.fromEntries(httpCompletion(new CompletionContext(state, pos, false))!.options.map((o) => [o.label, o.detail]));
    expect([details.name, details.timeout, details.prompt, details["httpdesk-auth"]]).toEqual([undefined, "Rider only", "VS Code only", "HttpDesk only"]);
  });
});
