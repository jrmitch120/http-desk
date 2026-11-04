import { describe, expect, it } from "vitest";
import {
  applyUrlText,
  buildForm,
  buildMultipart,
  composeUrl,
  newRequest,
  parseForm,
  parseMultipart,
  prettyXml,
  relativePath,
  setBodyMode,
  setDirective,
  getDirective,
  findHeader,
} from "./http";

describe("URL ⇄ query params", () => {
  it("composes only active params", () => {
    const r = newRequest();
    r.url = "https://x/a";
    r.query.items = [
      { enabled: true, name: "a", value: "1" },
      { enabled: false, name: "b", value: "2" },
      { enabled: true, name: "flag", value: "" },
    ];
    expect(composeUrl(r)).toBe("https://x/a?a=1&flag");
    r.query.enabled = false;
    expect(composeUrl(r)).toBe("https://x/a");
  });

  it("typing in the URL bar keeps disabled params in place", () => {
    const r = newRequest();
    r.query.items = [
      { enabled: true, name: "a", value: "1" },
      { enabled: false, name: "b", value: "2" },
      { enabled: true, name: "c", value: "3" },
    ];
    applyUrlText(r, "https://x/p?a=9&c=3&d=4");
    expect(r.url).toBe("https://x/p");
    expect(r.query.items).toEqual([
      { enabled: true, name: "a", value: "9" },
      { enabled: false, name: "b", value: "2" },
      { enabled: true, name: "c", value: "3" },
      { enabled: true, name: "d", value: "4" },
    ]);
    applyUrlText(r, "https://x/p");
    expect(r.query.items).toEqual([{ enabled: false, name: "b", value: "2" }]);
  });

  it("typing params re-enables a disabled section", () => {
    const r = newRequest();
    r.query.enabled = false;
    r.query.items = [{ enabled: true, name: "a", value: "1" }];
    applyUrlText(r, "https://x?z=1");
    expect(r.query.enabled).toBe(true);
    expect(r.query.items.map((i) => i.name)).toEqual(["z"]);
  });
});

describe("form bodies", () => {
  it("round-trips with encoding but keeps variables", () => {
    const fields = [
      { name: "name", value: "John Doe" },
      { name: "token", value: "{{token}}" },
      { name: "q", value: "a&b=c" },
    ];
    const text = buildForm(fields);
    expect(text).toBe("name=John%20Doe\n&token={{token}}\n&q=a%26b%3Dc");
    expect(parseForm(text)).toEqual(fields);
    expect(parseForm("a=1&b=two+words")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "two words" },
    ]);
  });
});

describe("multipart bodies", () => {
  it("round-trips text and file parts", () => {
    const parts = [
      { name: "title", kind: "text" as const, value: "Hello" },
      { name: "doc", kind: "file" as const, value: "./files/report.pdf", contentType: "application/pdf" },
    ];
    const text = buildMultipart(parts, "B");
    expect(text).toBe(
      [
        "--B",
        'Content-Disposition: form-data; name="title"',
        "",
        "Hello",
        "--B",
        'Content-Disposition: form-data; name="doc"; filename="report.pdf"',
        "Content-Type: application/pdf",
        "",
        "< ./files/report.pdf",
        "--B--",
      ].join("\n"),
    );
    expect(parseMultipart(text, "B")).toEqual([
      { name: "title", kind: "text", value: "Hello", contentType: undefined },
      { name: "doc", kind: "file", value: "./files/report.pdf", contentType: "application/pdf" },
    ]);
  });

  it("parses the JetBrains sample", () => {
    const text = `--WebAppBoundary
Content-Disposition: form-data; name="element-name"
Content-Type: text/plain

Name
--WebAppBoundary
Content-Disposition: form-data; name="data"; filename="data.json"
Content-Type: application/json

< ./request-form-data.json
--WebAppBoundary--`;
    const parts = parseMultipart(text, "WebAppBoundary");
    expect(parts.map((p) => [p.name, p.kind, p.value])).toEqual([
      ["element-name", "text", "Name"],
      ["data", "file", "./request-form-data.json"],
    ]);
  });
});

describe("body mode switching", () => {
  it("keeps Content-Type in sync", () => {
    const r = newRequest();
    setBodyMode(r, "json");
    expect(findHeader(r, "content-type")?.value).toBe("application/json");
    setBodyMode(r, "xml");
    expect(findHeader(r, "content-type")?.value).toBe("application/xml");
    r.headers.items[0].value = "application/vnd.custom+json";
    setBodyMode(r, "text");
    expect(findHeader(r, "content-type")?.value).toBe("application/vnd.custom+json");
  });

  it("converts form fields to multipart parts", () => {
    const r = newRequest();
    setBodyMode(r, "formUrlEncoded");
    r.body.text = "a=1\n&b=2";
    setBodyMode(r, "multipart");
    expect(findHeader(r, "content-type")?.value).toBe("multipart/form-data; boundary=HttpDeskBoundary");
    expect(parseMultipart(r.body.text, "HttpDeskBoundary").map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("directives", () => {
  it("set and remove", () => {
    const r = newRequest();
    setDirective(r, "no-redirect", "");
    setDirective(r, "timeout", "5");
    setDirective(r, "timeout", "10");
    expect(r.directives).toEqual([
      { name: "no-redirect", value: "" },
      { name: "timeout", value: "10" },
    ]);
    setDirective(r, "no-redirect", null);
    expect(getDirective(r, "no-redirect")).toBeUndefined();
  });
});

describe("misc", () => {
  it("pretty prints xml", () => {
    expect(prettyXml('<?xml version="1.0"?><a><b>text</b><c/><d><e>1</e></d></a>')).toBe(
      ['<?xml version="1.0"?>', "<a>", "  <b>text</b>", "  <c/>", "  <d>", "    <e>1</e>", "  </d>", "</a>"].join("\n"),
    );
  });

  it("computes relative paths", () => {
    expect(relativePath("/w/api", "/w/api/files/a.json")).toBe("./files/a.json");
    expect(relativePath("/w/api", "/w/data/a.json")).toBe("../data/a.json");
  });
});
