import { describe, expect, it } from "vitest";
import {
  applyUrlText,
  base64DecodedLength,
  buildForm,
  buildMultipart,
  composeUrl,
  newRequest,
  parseFileRef,
  parseForm,
  parseMultipart,
  relativePath,
  setBodyMode,
  setDirective,
  getDirective,
  findHeader,
  formatBulk,
  parseBulk,
  headerNameError,
  basicUsernameError,
  variableNameError,
  bodySyntaxWarnings,
  customMethod,
  type BulkRow,
  type MultipartPart,
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

  it("typing in the URL bar keeps param descriptions", () => {
    const r = newRequest();
    r.query.items = [
      { enabled: true, name: "limit", value: "5", description: "Max results" },
      { enabled: false, name: "area", value: "KS", description: "State code" },
    ];
    applyUrlText(r, "https://x/p?limit=50");
    expect(r.query.items).toEqual([
      { enabled: true, name: "limit", value: "50", description: "Max results" },
      { enabled: false, name: "area", value: "KS", description: "State code" },
    ]);
  });

  it("shows the file's escaping in the URL bar and decoded values in the table (ADR-0001)", () => {
    const r = newRequest();
    r.url = "https://x/s";
    r.query.items = [
      { enabled: true, name: "q", value: "a&b=c" },
      { enabled: true, name: "a=b c", value: "100% of #1 and %20" },
      { enabled: true, name: "t", value: "{{ term }}" },
      { enabled: true, name: "email", value: "a%40b.c" },
      { enabled: true, name: "flag", value: "", equals: true },
      { enabled: true, name: "bare", value: "" },
    ];
    const url = composeUrl(r);
    expect(url).toBe("https://x/s?q=a%26b=c&a%3Db%20c=100%25%20of%20%231%20and%20%2520&t={{ term }}&email=a%40b.c&flag=&bare");
    const items = r.query.items.map((i) => ({ ...i }));
    applyUrlText(r, url);
    expect(r.query.items).toEqual(items.map((i) => (i.equals ? i : { enabled: true, name: i.name, value: i.value })));
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

const on = (name: string, value: string) => ({ name, value, enabled: true });
const off = (name: string, value: string) => ({ name, value, enabled: false });

describe("form bodies", () => {
  it("round-trips with encoding but keeps variables", () => {
    const fields = [on("name", "John Doe"), on("token", "{{token}}"), on("q", "a&b=c")];
    const text = buildForm(fields);
    expect(text).toBe("name=John%20Doe\n&token={{token}}\n&q=a%26b%3Dc");
    expect(parseForm(text)).toEqual(fields);
    expect(parseForm("a=1&b=two+words")).toEqual([on("a", "1"), on("b", "two words")]);
  });

  it("reads a body written one field per line, as it is sent", () => {
    expect(parseForm("a=1\nb=2\n&c=3&\nd=4")).toEqual([on("a", "1"), on("b", "2"), on("c", "3"), on("d", "4")]);
  });

  it("writes disabled fields in place as #~ lines, the first sent field without &", () => {
    // JetBrains sends an empty body when the first line it sends starts with `&`.
    const fields = [off("a", "1"), on("b", "2"), off("c", "3"), on("d", "4")];
    const text = buildForm(fields);
    expect(text).toBe("#~ a=1\nb=2\n#~ &c=3\n&d=4");
    expect(parseForm(text)).toEqual(fields);
    expect(parseForm("#~ a=1&b=2\n&c=3")).toEqual([off("a", "1"), off("b", "2"), on("c", "3")]);
  });

  it("never writes a field that would read back as a comment", () => {
    const fields = [on("//x", "1"), off("//y", "2")];
    // `#` and `/` are escaped, so a field never starts with `#` or `//`.
    expect(buildForm(fields)).toBe("%2F%2Fx=1\n#~ &%2F%2Fy=2");
    expect(parseForm(buildForm(fields))).toEqual(fields);
  });

  it("keeps plain comments as comments, not fields", () => {
    const text = "a=1\n# a note\n// another\n&c=3\n# at the end";
    const fields = parseForm(text);
    expect(fields.map((f) => [f.name, f.enabled])).toEqual([
      ["a", true],
      ["c", true],
    ]);
    expect(buildForm(fields)).toBe(text);
  });
});

describe("file bodies", () => {
  it("reads `< path` and `<@ path` with or without a space, as they are sent", () => {
    expect(parseFileRef("< ./a.json")).toEqual({ substitute: false, path: "./a.json" });
    expect(parseFileRef("<./a.json")).toEqual({ substitute: false, path: "./a.json" });
    expect(parseFileRef("<@./a.json\n")).toEqual({ substitute: true, path: "./a.json" });
    expect(parseFileRef("<@ ./a.json")).toEqual({ substitute: true, path: "./a.json" });
    expect(parseFileRef("<tag/>")).toBeNull();
    expect(parseFileRef("<?xml version=1.0")).toBeNull();
    expect(parseFileRef("< ./a.json\n< ./b.json")).toBeNull();
  });
});

describe("multipart bodies", () => {
  it("round-trips text and file parts", () => {
    const parts = [
      { name: "title", kind: "text" as const, value: "Hello", enabled: true },
      { name: "doc", kind: "file" as const, value: "./files/report.pdf", contentType: "application/pdf", enabled: true },
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
      { name: "title", kind: "text", value: "Hello", contentType: undefined, enabled: true },
      { name: "doc", kind: "file", value: "./files/report.pdf", contentType: "application/pdf", enabled: true },
    ]);
  });

  it("holds disabled parts inline as #~ lines, in place", () => {
    // The serializer moves these lines to the header area (#~=), because
    // JetBrains sends comment lines inside a part.
    const parts = [
      { name: "a", kind: "text" as const, value: "1", enabled: false },
      { name: "b", kind: "text" as const, value: "two\nlines", enabled: true },
      { name: "f", kind: "file" as const, value: "./x.bin", contentType: "image/png", enabled: false },
    ];
    const text = buildMultipart(parts, "B");
    expect(text).toBe(
      [
        "#~ --B",
        '#~ Content-Disposition: form-data; name="a"',
        "#~",
        "#~ 1",
        "--B",
        'Content-Disposition: form-data; name="b"',
        "",
        "two",
        "lines",
        "#~ --B",
        '#~ Content-Disposition: form-data; name="f"; filename="x.bin"',
        "#~ Content-Type: image/png",
        "#~",
        "#~ < ./x.bin",
        "--B--",
      ].join("\n"),
    );
    expect(parseMultipart(text, "B")).toEqual(parts);
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

  it("keeps each field's enabled state between form and multipart", () => {
    const r = newRequest();
    setBodyMode(r, "formUrlEncoded");
    r.body.text = "a=1\n#~ &b=2";
    setBodyMode(r, "multipart");
    expect(parseMultipart(r.body.text, "HttpDeskBoundary").map((p) => [p.name, p.enabled])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    setBodyMode(r, "formUrlEncoded");
    expect(r.body.text).toBe("a=1\n#~ &b=2");
  });

  it("removes the Content-Type it added when switching to none", () => {
    const r = newRequest();
    r.headers.items.push({ enabled: true, name: "Accept", value: "application/json" });
    setBodyMode(r, "json");
    setBodyMode(r, "none");
    expect(r.headers.items).toEqual([{ enabled: true, name: "Accept", value: "application/json" }]);

    setBodyMode(r, "multipart");
    setBodyMode(r, "none");
    expect(findHeader(r, "content-type")).toBeUndefined();
  });

  it("keeps a Content-Type the user typed when switching to none", () => {
    const r = newRequest();
    setBodyMode(r, "json");
    findHeader(r, "content-type")!.value = "application/json; charset=utf-8";
    setBodyMode(r, "none");
    expect(findHeader(r, "content-type")?.value).toBe("application/json; charset=utf-8");

    const typed = newRequest();
    typed.body.mode = "text";
    typed.headers.items.push({ enabled: true, name: "Content-Type", value: "application/xml" });
    setBodyMode(typed, "none");
    expect(findHeader(typed, "content-type")?.value).toBe("application/xml");
  });
});

describe("bulk edit", () => {
  const headers = [
    { enabled: true, name: "Accept", value: "application/json", description: "What we read" },
    { enabled: false, name: "X-Debug", value: "1" },
  ];

  it("shows rows as text, one per line, with // marking disabled ones", () => {
    expect(formatBulk(headers, ":", true)).toBe("Accept: application/json\n//X-Debug: 1");
    expect(formatBulk([{ enabled: true, name: "page", value: "2" }], "=", true)).toBe("page=2");
  });

  it("turns text back into rows, keeping descriptions by name", () => {
    expect(parseBulk("//X-Debug: 1\n\nAccept: text/plain\nX-New", ":", headers)).toEqual([
      { enabled: false, name: "X-Debug", value: "1" },
      { enabled: true, name: "Accept", value: "text/plain", description: "What we read" },
      { enabled: true, name: "X-New", value: "" },
    ]);
  });

  it("keeps a description while its name is retyped, since every keystroke is applied", () => {
    // Rows are re-parsed from the text on each input, always against the rows
    // the bulk edit started from, so a half-typed name doesn't lose the doc.
    expect(parseBulk("Acc: application/json", ":", headers)[0].description).toBeUndefined();
    expect(parseBulk("Accept: application/json", ":", headers)[0].description).toBe("What we read");
  });

  it("works on any row type, carrying the fields the text can't show over by name", () => {
    const parts: MultipartPart[] = [
      { name: "avatar", kind: "file", value: "./cat.png", contentType: "image/png", enabled: true },
      { name: "note", kind: "text", value: "hi", enabled: false },
    ];
    expect(formatBulk(parts, ":", true)).toBe("avatar: ./cat.png\n//note: hi");
    const blank = (): MultipartPart => ({ name: "", kind: "text", value: "", enabled: true });
    expect(parseBulk("note: hello\n//avatar: ./dog.png\nextra: 1", ":", parts, { blank, carry: ["kind", "contentType"] })).toEqual([
      { name: "note", kind: "text", value: "hello", enabled: true },
      { name: "avatar", kind: "file", value: "./dog.png", contentType: "image/png", enabled: false },
      { name: "extra", kind: "text", value: "1", enabled: true },
    ]);
  });

  it("reads // as disabled only for rows that can be disabled", () => {
    const blank = (): BulkRow => ({ name: "", value: "" });
    expect(parseBulk("//a=1\nb=2", "=", [], { blank, carry: [] })).toEqual([
      { name: "//a", value: "1" },
      { name: "b", value: "2" },
    ]);
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
  it("computes relative paths", () => {
    expect(relativePath("/w/api", "/w/api/files/a.json")).toBe("./files/a.json");
    expect(relativePath("/w/api", "/w/data/a.json")).toBe("../data/a.json");
  });
});

describe("field safety", () => {
  it("accepts header names that read back as headers", () => {
    for (const n of ["Accept", "X-Request-Id", "{{headerName}}", "X-Ok!", ""]) expect(headerNameError(n)).toBeNull();
  });

  it("rejects header names that would read back as something else", () => {
    expect(headerNameError("X\nEvil")).toBe("Header names can't contain line breaks");
    expect(headerNameError("X Trace")).toBe("Header names can't contain spaces");
    expect(headerNameError("X:Trace")).toBe("Header names can't contain ':'");
    expect(headerNameError("#Trace")).toBe("Header names can't start with '#'");
    expect(headerNameError("//Trace")).toBe("Header names can't start with '//'");
    for (const p of ["~", "|", "&", "?"]) expect(headerNameError(`${p}x`)).toBe(`Header names can't start with '${p}'`);
  });

  it("validates variable names like the parser", () => {
    for (const n of ["host", "$pet.id-2_x", "café", "v2", ""]) expect(variableNameError(n)).toBeNull();
    for (const n of ["base url", "a=b", "a\nb", "{{x}}"]) expect(variableNameError(n)).toBe("Variable names can only use letters, digits, _, -, . and $");
  });

  it("rejects Basic auth usernames containing ':' (RFC 7617)", () => {
    for (const n of ["alice", "{{user}}", "first last", ""]) expect(basicUsernameError(n)).toBeNull();
    expect(basicUsernameError("dom:ain")).toBe("Basic auth usernames can't contain ':'");
  });

  it("warns about body lines that .http syntax reads as a separator or handler", () => {
    const text = ["Intro", "### Heading", "  ### indented is fine", ">> out.txt", "> {% client.log(1) %}", "> check.js", "  > {% indented %}", "> quoted text", "end"].join("\n");
    expect(bodySyntaxWarnings(text)).toEqual([
      { line: 2, message: "Line 2 starts with ###, so it will be read as the start of a new request." },
      { line: 4, message: "Line 4 starts with >>, so it and the lines after it will be read as a response handler." },
      { line: 5, message: "Line 5 starts with >, so it and the lines after it will be read as a response handler." },
      { line: 6, message: "Line 6 starts with >, so it and the lines after it will be read as a response handler." },
    ]);
    expect(bodySyntaxWarnings('{\n  "a": 1\n}')).toEqual([]);
  });
});

describe("custom methods", () => {
  it("uppercases a typed method token", () => {
    expect(customMethod("purge")).toBe("PURGE");
    expect(customMethod("  Report ")).toBe("REPORT");
    expect(customMethod("x-sync_2")).toBe("X-SYNC_2");
  });

  it("rejects text the .http parser wouldn't read back as a method", () => {
    for (const t of ["", " ", "bad method", "pur/ge", "2PUT", "-X", "ÜBER", "{{m}}"]) expect(customMethod(t)).toBeNull();
  });
});

describe("base64DecodedLength", () => {
  it("counts the bytes a base64 string decodes to, padding included", () => {
    expect(base64DecodedLength("")).toBe(0);
    expect(base64DecodedLength("QQ==")).toBe(1); // "A"
    expect(base64DecodedLength("QUI=")).toBe(2); // "AB"
    expect(base64DecodedLength("QUJD")).toBe(3); // "ABC"
    expect(base64DecodedLength("QUJDRA==")).toBe(4);
  });
});
