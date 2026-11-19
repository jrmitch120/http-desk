// Reading a file view's text a `###` block at a time (#168): what it reads is what
// the core reads in the whole text, and only the blocks an edit touched go to the core.
import { describe, expect, it } from "vitest";
import { invokeCore } from "../dev/textCore";
import { FileReader, type TextCore } from "./fileReader";
import type { ParsedFile, PortabilityMark } from "./types";

/** The real core (WASM), as the shell runs it, recording the texts it's given. */
function core() {
  const texts: string[] = [];
  const port: TextCore = {
    parseFileText: async (text) => (texts.push(text), invokeCore<ParsedFile>("parse_file_text", { text })),
    portabilityText: async (text) => (texts.push(text), invokeCore<PortabilityMark[]>("portability_text", { text })),
  };
  return { port, texts };
}

/** The core reading the whole of `text` at once. */
const whole = (text: string) => invokeCore<ParsedFile>("parse_file_text", { text });
const wholeMarks = (text: string) => invokeCore<PortabilityMark[]>("portability_text", { text });

const TEXT = [
  "@host = https://example.com",
  "# The pet store",
  "",
  "### List",
  "# @name list",
  "GET {{host}}/pets?limit=20",
  "Accept: application/json",
  "",
  "### Create",
  "POST {{host}}/pets",
  "Content-Type: application/json",
  "",
  '{ "name": "Rex" }',
  "",
  "> {%",
  '  client.global.set("id", response.body.id);',
  "%}",
  "",
  "### Delete",
  "# @frobnicate",
  "DELETE {{host}}/pets/{{id}} now",
  "",
].join("\n");

describe("reading a file view's text a block at a time", () => {
  it("reads an edit inside a request as the core reads the whole text, sending it only that block", async () => {
    const { port, texts } = core();
    const reader = new FileReader(port);
    expect(await reader.parse(TEXT)).toEqual(whole(TEXT));

    texts.length = 0;
    const edited = TEXT.replace("Accept: application/json", "Accept: application/xml\nX-Trace: on");
    expect(await reader.parse(edited)).toEqual(whole(edited));
    expect(texts).toEqual(["### List\n# @name list\nGET {{host}}/pets?limit=20\nAccept: application/xml\nX-Trace: on\n\n"]);
  });

  // Each edit from the one before, so every reading but the first reuses blocks.
  const edits: [string, (t: string) => string][] = [
    ["a `###` added inside a request, splitting it", (t) => t.replace('{ "name": "Rex" }\n', '{ "name": "Rex" }\n\n### Split off\nGET {{host}}/split\n')],
    ["a `###` removed, joining two requests", (t) => t.replace("### Split off\n", "")],
    ["a `###` added with no request under it, so its text goes before the next request", (t) => t.replace("### Delete", "### Notes\n# just a comment\n\n### Delete")],
    ["a File variable changed at the top", (t) => t.replace("@host = https://example.com", "@host = https://example.org\n@token = abc")],
    ["the header removed, so the file starts with `###`", (t) => t.slice(t.indexOf("### List"))],
    ["a request line above the first `###`, so the first block is a request", (t) => `GET {{host}}/first\n\n${t}`],
    ["a File variable added at the top again", (t) => `@host = https://example.net\n\n${t.slice(t.indexOf("### List"))}`],
    ["an error fixed", (t) => t.replace("{{id}} now", "{{id}}")],
    ["the last request's line ending dropped", (t) => t.replace(/\n+$/, "")],
    ["text after the last request with no request line", (t) => `${t}\n\n### Unfinished\n# todo`],
    ["the last `###` removed", (t) => t.replace("### Unfinished\n", "")],
    ["everything removed", () => ""],
    ["a single request", () => "GET https://example.com/one"],
  ];
  it.each(edits.map((e, i) => [e[0], i] as const))("reads %s as the core reads the whole text", async (_, upTo) => {
    const reader = new FileReader(core().port);
    let text = TEXT;
    await reader.parse(text);
    for (const [, edit] of edits.slice(0, upTo + 1)) {
      text = edit(text);
      expect(await reader.parse(text)).toEqual(whole(text));
      expect(await reader.portability(text)).toEqual(wholeMarks(text));
    }
  });

  it("reads text with CRLF line endings or a byte order mark whole", async () => {
    const { port, texts } = core();
    const reader = new FileReader(port);
    for (const text of [TEXT.replaceAll("\n", "\r\n"), `\u{FEFF}${TEXT}`]) {
      texts.length = 0;
      expect(await reader.parse(text)).toEqual(whole(text));
      expect(texts).toEqual([text]);
    }
  });

  it("sends a text with many blocks it hasn't read to the core whole, then reuses its blocks", async () => {
    const { port, texts } = core();
    const reader = new FileReader(port);
    const many = Array.from({ length: 30 }, (_, i) => `### R${i}\nGET https://example.com/${i}${i % 7 ? "" : " bad"}\n# @what${i}\n`).join("\n");
    expect(await reader.parse(many)).toEqual(whole(many));
    expect(await reader.portability(many)).toEqual(wholeMarks(many));
    expect(texts).toEqual([many, many]);

    texts.length = 0;
    const edited = many.replace("/14 bad", "/14");
    expect(await reader.parse(edited)).toEqual(whole(edited));
    expect(await reader.portability(edited)).toEqual(wholeMarks(edited));
    expect(texts).toEqual(["### R14\nGET https://example.com/14\n# @what14\n\n", "### R14\nGET https://example.com/14\n# @what14\n\n"]);
  });

  it("reads random edits to every sample file as the core reads the whole text", async () => {
    const samples = Object.values(import.meta.glob("../dev/*.http", { query: "?raw", import: "default", eager: true }) as Record<string, string>);
    // A small seeded generator, so a failure repeats.
    let seed = 168;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const pieces = ["###", "### Added\n", "\n", "GET https://x.test/a b\n", "@v = 1\n", "# @nope\n", "Accept: */*\n", "{\n", "> {%\n", "%}\n", "x"];
    for (const sample of samples) {
      const reader = new FileReader(core().port);
      let text = sample.replaceAll("\r", "");
      for (let step = 0; step < 60; step++) {
        const at = random(text.length + 1);
        const cut = random(3) === 0 ? random(40) : 0;
        text = text.slice(0, at) + (random(4) === 0 ? "" : pieces[random(pieces.length)]) + text.slice(at + cut);
        expect(await reader.parse(text)).toEqual(whole(text));
        expect(await reader.portability(text)).toEqual(wholeMarks(text));
      }
    }
  });
});
