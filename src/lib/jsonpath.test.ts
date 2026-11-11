import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { keyCompletion, pathAt, pathInPieces, pathScan } from "./jsonpath";
import type { JsonShape } from "./types";

/** The shape of `{"items": [{"id", "name", "owner": {"name"}, "odd key"}], "total", "1": {"x"}}`. */
const SHAPE: JsonShape = {
  keys: [
    ["items", { items: { keys: [["id", {}], ["name", {}], ["owner", { keys: [["name", {}]] }], ["odd key", {}]] } }],
    ["total", {}],
    ["1", { keys: [["x", {}]] }],
  ],
};

/** The suggestions offered with the caret at the end of `text`, as the text accepting each would give. */
function suggest(text: string): string[] {
  const c = keyCompletion(text, text.length, SHAPE);
  return c ? c.matches.map((m) => text.slice(0, c.from) + m.insert) : [];
}

describe("filter key completion", () => {
  it("offers the keys of array items after a wildcard", () => {
    expect(suggest("$.items[*].")).toEqual(["$.items[*].id", "$.items[*].name", "$.items[*].owner", "$.items[*]['odd key']"]);
  });

  it("offers the root's keys, narrowed by what's typed, quoting keys that need it", () => {
    expect(suggest("$.")).toEqual(["$.items", "$.total", "$['1']"]);
    expect(suggest("$.t")).toEqual(["$.total", "$.items"]);
    expect(suggest("$.items[0].o")).toEqual(["$.items[0].owner", "$.items[0]['odd key']"]);
  });

  it("follows names, quoted names, filters and slices through the shape", () => {
    expect(suggest("$.items[*].owner.")).toEqual(["$.items[*].owner.name"]);
    expect(suggest("$['1'].")).toEqual(["$['1'].x"]);
    expect(suggest('$.items[?(@.name=="a]b")].i')).toEqual(['$.items[?(@.name=="a]b")].id']);
    expect(suggest("$.items[1:3, 0].i")).toEqual(["$.items[1:3, 0].id"]);
    expect(suggest("$.*.")).toEqual(["$.*.x"]);
    expect(suggest("$.nope.")).toEqual([]);
  });

  it("completes a quoted name inside brackets", () => {
    expect(suggest("$.items[*]['od")).toEqual(["$.items[*]['odd key']"]);
    expect(suggest('$["it')).toEqual(["$['items']"]);
  });

  it("offers keys anywhere below after a descendant segment", () => {
    expect(suggest("$..n")).toEqual(["$..name", "$..owner"]);
    expect(suggest("$..od")).toEqual(["$..['odd key']"]);
  });

  it("offers nothing where no key is being typed", () => {
    expect(keyCompletion("", 0, SHAPE)).toBeNull();
    expect(keyCompletion("items.", 6, SHAPE)).toBeNull();
    expect(keyCompletion("$.items[0]", 10, SHAPE)).toBeNull();
    expect(keyCompletion('$.items[?(@.name == "a', 22, SHAPE)).toBeNull();
    // Only the text before the caret counts.
    expect(keyCompletion("$.to.items", 4, SHAPE)?.matches.map((m) => m.value)).toEqual(["total"]);
  });
});

/** The path at the `|` in `marked` (the marker itself is removed). */
const at = (marked: string) => pathAt(marked.replace("|", ""), marked.indexOf("|"));

describe("Copy path", () => {
  it("names the value under the cursor, bracket-quoting keys that aren't identifiers", () => {
    expect(at('{"a":{"odd key":[{"b":|1}]}}')).toBe("$.a['odd key'][0].b");
    expect(at('{"a":{"odd key":[{"b":1|}]}}')).toBe("$.a['odd key'][0].b");
  });

  it("works on pretty-printed text, with the cursor on a key, a string or a bracket", () => {
    const pretty = '{\n  "items": [\n    {\n      "id": 1,\n      "tags": ["a", "b"]\n    }\n  ]\n}';
    const on = (needle: string, delta = 1) => pathAt(pretty, pretty.indexOf(needle) + delta);
    expect(on('"items"')).toBe("$.items");
    expect(on('"id"', 3)).toBe("$.items[0].id");
    expect(on('"b"')).toBe("$.items[0].tags[1]");
    expect(on('["a"', 0)).toBe("$.items[0].tags");
    expect(on("    }", 4)).toBe("$.items[0]");
  });

  it("names the innermost container between values, and the member between a key and its value", () => {
    expect(at('{"a": [1, |2]}')).toBe("$.a[1]");
    expect(at('{"a": [1,| 2]}')).toBe("$.a");
    expect(at('{"a": |{"b": 1}}')).toBe("$.a");
    expect(at('{"a": 1, |"b": 2}')).toBe("$.b");
    expect(at('{"a": 1,| "b": 2}')).toBe("$");
    expect(at("|[1]")).toBe("$");
    expect(at("4|2")).toBe("$");
  });

  it("reads keys and strings with escapes, quotes and brackets in them", () => {
    expect(at(String.raw`{"a\"b": {"x]": "}{", "y": |1}}`)).toBe(`$['a"b'].y`);
    expect(at(String.raw`{"café": |1}`)).toBe("$['café']");
    expect(at(`{"it's": |1}`)).toBe(String.raw`$['it\'s']`);
    expect(at(String.raw`{"back\\slash": |1}`)).toBe(String.raw`$['back\\slash']`);
    expect(at('{"a-b": {"_ok9": |1}}')).toBe("$['a-b']._ok9");
  });

  it("gives up on text that isn't JSON before the cursor", () => {
    expect(at("{1: |2}")).toBeNull();
    expect(at('{"a": 1]|')).toBeNull();
  });
});

describe("Copy path in pieces", () => {
  /** `marked` split into `size`-character pieces, and the caret offset of its `|`. */
  const pieces = (marked: string, size: number) => {
    const text = marked.replace("|", "");
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    return { parts, offset: marked.indexOf("|") };
  };

  it("reads keys, strings and escapes split across pieces as one", () => {
    for (const marked of [String.raw`{"a\"b": {"x]": "}{", "y": |1}}`, '{"a":{"odd key":[{"b":|1}]}}', '{"a": 1,| "b": 2}', "4|2"]) {
      for (const size of [1, 2, 3, 5]) {
        const { parts, offset } = pieces(marked, size);
        const scan = pathScan(parts[Symbol.iterator](), offset);
        let step = scan.next();
        while (!step.done) step = scan.next();
        expect(step.value, `${marked} in ${size}-character pieces`).toBe(at(marked));
      }
    }
  });

  it("pauses as it reads, and reads a CodeMirror document by its lines", async () => {
    const lines = ["{", '  "items": [', ...Array.from({ length: 1000 }, (_, i) => `    {"id": ${i}},`), '    {"id": "last"}', "  ]", "}"];
    const doc = Text.of(lines);
    const offset = doc.toString().indexOf('"last"') + 1;
    let pauses = 0;
    const scan = pathScan(doc.iter(), offset, 1000);
    let step = scan.next();
    for (; !step.done; step = scan.next()) pauses++;
    expect(step.value).toBe("$.items[1000].id");
    expect(pauses).toBeGreaterThan(10);
    expect(await pathInPieces(doc.iter(), offset)).toBe("$.items[1000].id");
  });
});
