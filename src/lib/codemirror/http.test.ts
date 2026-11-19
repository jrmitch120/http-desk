// The `.http` language: each construct of a request's source gets its highlight
// token, read the way the core's parser reads the text.
import { describe, expect, it } from "vitest";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { EditorState } from "@codemirror/state";
import { foldable } from "@codemirror/language";
import { bodySyntaxWarnings } from "../http";
import { http, httpLanguage } from "./http";

/** The highlighted spans of `text`, as `classHighlighter` names their tokens. */
function spans(text: string): { from: number; to: number; cls: string }[] {
  const out: { from: number; to: number; cls: string }[] = [];
  highlightTree(httpLanguage.parser.parse(text), classHighlighter, (from, to, cls) => out.push({ from, to, cls }));
  return out;
}

/**
 * The token `needle` (its first occurrence in `text` after the text `after`) is
 * highlighted as: the class of the one span covering all of it, or a list of
 * what covers it.
 */
function token(text: string, needle: string, after = ""): string {
  const at = text.indexOf(needle, after ? text.indexOf(after) + after.length : 0);
  if (at < 0 || (after && !text.includes(after))) throw new Error(`no ${JSON.stringify(needle)} after ${JSON.stringify(after)} in the text`);
  const end = at + needle.length;
  const all = spans(text);
  const covering = all.find((s) => s.from <= at && s.to >= end);
  if (covering) return covering.cls;
  const parts = all.filter((s) => s.from < end && s.to > at);
  return parts.length ? `mixed: ${parts.map((s) => `${text.slice(s.from, s.to)}=${s.cls}`).join(", ")}` : "none";
}

describe("request line", () => {
  const text = "POST https://example.com/pets HTTP/1.1\n";

  it("highlights the method, the URL and the HTTP version", () => {
    expect(token(text, "POST")).toBe("tok-keyword");
    expect(token(text, "https://example.com/pets")).toBe("tok-url");
    expect(token(text, "HTTP/1.1")).toBe("tok-atom");
  });
});

describe("separators and headers", () => {
  const text = "### List pets\nGET /pets\nAccept: application/json\nX-Debug:1\n\n###\nGET /other\n";

  it("highlights each ### line as a separator, with its name", () => {
    expect(token(text, "### List pets")).toBe("tok-heading");
    expect(token(text, "###", "\n\n")).toBe("tok-heading");
    expect(token(text, "GET", "\n\n")).toBe("tok-keyword");
  });

  it("highlights a header's name and value, and the colon between them", () => {
    expect(token(text, "Accept")).toBe("tok-propertyName");
    expect(token(text, ":")).toBe("tok-punctuation");
    expect(token(text, "application/json")).toBe("tok-string");
    expect(token(text, "X-Debug")).toBe("tok-propertyName");
    expect(token(text, "1")).toBe("tok-string");
  });
});

describe("variables", () => {
  const text = "@api = {{host}}/v2\nGET {{api}}/pets?page={{ page }}\nAuthorization: Bearer {{token}}\n";

  it("marks each {{variable}} in a File variable, the URL and a header value, apart from the text around it", () => {
    expect(token(text, "{{host}}")).toBe("tok-variableName2");
    expect(token(text, "/v2")).toBe("tok-string");
    expect(token(text, "{{api}}")).toBe("tok-variableName2");
    expect(token(text, "/pets?page=")).toBe("tok-url");
    expect(token(text, "{{ page }}")).toBe("tok-variableName2");
    expect(token(text, "Bearer ")).toBe("tok-string");
    expect(token(text, "{{token}}")).toBe("tok-variableName2");
  });
});

describe("bodies", () => {
  it("highlights a JSON body as JSON, with its variables marked", () => {
    const text = 'POST /pets\n    ?dry=1\n    &v=2\nContent-Type: application/json\n\n{\n  "name": "{{name}}",\n  "age": 3\n}\n';
    expect(token(text, "?dry=1")).toBe("tok-url");
    expect(token(text, '"name"')).toBe("tok-propertyName");
    expect(token(text, "{{name}}")).toBe("tok-variableName2");
    expect(token(text, "3")).toBe("tok-number");
  });

  it("reads a body as JSON without a Content-Type when it starts with { or [", () => {
    expect(token('POST /pets\n\n[{"id": 1}]', '"id"')).toBe("tok-propertyName");
  });

  it("highlights an XML body as XML", () => {
    const text = 'POST /pets\nContent-Type: application/xml\n\n<?xml version="1.0"?>\n<pet kind="{{kind}}">\n  <name>Rex</name>\n</pet>\n';
    expect(token(text, "pet", "\n\n")).toBe("tok-typeName");
    expect(token(text, "kind", "<pet")).toBe("tok-propertyName");
    expect(token(text, "{{kind}}")).toBe("tok-variableName2");
    expect(token(text, "name", "\n\n")).toBe("tok-typeName");
  });

  it("reads a body as XML without a Content-Type when it starts with <", () => {
    expect(token("POST /pets\n\n<pet>Rex</pet>", "pet", "<")).toBe("tok-typeName");
  });

  it("highlights an HTML body as HTML", () => {
    const text = 'POST /pages\nContent-Type: text/html; charset=utf-8\n\n<p class="lead">Hi</p>\n';
    expect(token(text, "p", "\n\n")).toBe("tok-typeName");
    expect(token(text, "class")).toBe("tok-propertyName");
  });

  it("highlights a GraphQL body as GraphQL", () => {
    const query = "query Pet($id: ID!) {\n  pet(id: $id) { name }\n}\n\n{\"id\": 1}\n";
    for (const text of [
      `POST /graphql\nX-REQUEST-TYPE: GraphQL\nContent-Type: application/json\n\n${query}`,
      `GRAPHQL /graphql\n\n${query}`,
      `POST /graphql\nContent-Type: application/graphql\n\n${query}`,
    ]) {
      expect(token(text, "query")).toBe("tok-keyword");
      expect(token(text, "$id")).toBe("tok-variableName");
      expect(token(text, "name")).toBe("tok-propertyName");
      expect(token(text, '"id"')).toBe("tok-string");
    }
  });

  it("leaves a body of another type plain, with its variables marked", () => {
    const text = "POST /form\nContent-Type: application/x-www-form-urlencoded\n\nname={{name}}&tag=dog\n";
    expect(token(text, "name=")).toBe("none");
    expect(token(text, "{{name}}")).toBe("tok-variableName2");
  });
});

describe("files and scripts", () => {
  it("highlights a body read from a file: < and <@ references", () => {
    const text = "POST /x\nContent-Type: application/json\n\n< ./payload.json\n";
    expect(token(text, "<")).toBe("tok-operator");
    expect(token(text, "./payload.json")).toBe("tok-link");
    expect(token("POST /x\n\n<@ ./{{name}}.xml", "<@")).toBe("tok-operator");
  });

  it("highlights the < references of a multipart body's parts", () => {
    const text = "POST /x\nContent-Type: multipart/form-data; boundary=b\n\n--b\nContent-Disposition: form-data; name=\"f\"\n\n< ./photo.png\n--b--\n";
    expect(token(text, "./photo.png")).toBe("tok-link");
  });

  it("reads a body line starting with < as XML, not a reference, when there's more to the body", () => {
    const text = "POST /x\n\n<pet\n  kind=\"cat\"/>\n";
    expect(token(text, "pet")).toBe("tok-typeName");
  });

  it("highlights a response handler's script as JavaScript", () => {
    const text = 'GET /x\n\n> {%\n  client.global.set("token", response.body.token);\n%}\n';
    expect(token(text, ">")).toBe("tok-operator");
    expect(token(text, "{%")).toBe("tok-punctuation");
    expect(token(text, "client")).toBe("tok-variableName");
    expect(token(text, '"token"')).toBe("tok-string");
    expect(token(text, "%}")).toBe("tok-punctuation");
  });

  it("highlights a one-line handler, a handler file and a redirect", () => {
    const text = "GET /x\n\n> {% client.log(1) %}\n> ./check.js\n>> ./out.json\n>>! ./{{name}}.json\n";
    expect(token(text, "client")).toBe("tok-variableName");
    expect(token(text, "1")).toBe("tok-number");
    expect(token(text, "./check.js")).toBe("tok-link");
    expect(token(text, ">>")).toBe("tok-operator");
    expect(token(text, "./out.json")).toBe("tok-link");
    expect(token(text, ">>!")).toBe("tok-operator");
    expect(token(text, "{{name}}")).toBe("tok-variableName2");
  });

  it("highlights a pre-request script as JavaScript, and a pre-request script file", () => {
    const text = '< {%\n  request.variables.set("id", 1);\n%}\n< ./sign.js\nGET /x\n';
    expect(token(text, "<")).toBe("tok-operator");
    expect(token(text, "request")).toBe("tok-variableName");
    expect(token(text, '"id"')).toBe("tok-string");
    expect(token(text, "./sign.js")).toBe("tok-link");
    expect(token(text, "GET")).toBe("tok-keyword");
  });
});

describe("comments, directives and File variables", () => {
  const text = [
    "@host = https://example.com",
    "",
    "###",
    "# Lists the pets",
    "// also a comment",
    "# @name listPets",
    "// @no-cookie-jar",
    "#@prompt otp One-time code",
    "#   @indented is description text",
    "@page = 2",
    "GET {{host}}/pets",
    "Accept: */*",
    "#~ X-Debug: 1",
    "#~&limit=5",
    "# a note in the headers",
    "",
  ].join("\n");

  it("highlights a File variable's name, its = and its value", () => {
    expect(token(text, "@host")).toBe("tok-variableName tok-definition");
    expect(token(text, "=")).toBe("tok-operator");
    expect(token(text, "https://example.com")).toBe("tok-string");
    expect(token(text, "@page")).toBe("tok-variableName tok-definition");
  });

  it("highlights # and // comments", () => {
    expect(token(text, "# Lists the pets")).toBe("tok-comment");
    expect(token(text, "// also a comment")).toBe("tok-comment");
    expect(token(text, "#   @indented is description text")).toBe("tok-comment");
    expect(token(text, "# a note in the headers")).toBe("tok-comment");
  });

  it("highlights a directive's name and value", () => {
    expect(token(text, "@name")).toBe("tok-meta");
    expect(token(text, "listPets")).toBe("tok-string");
    expect(token(text, "@no-cookie-jar")).toBe("tok-meta");
    expect(token(text, "@prompt")).toBe("tok-meta");
    expect(token(text, "otp One-time code")).toBe("tok-string");
  });

  it("highlights a #~ disabled line as a comment that's switched off", () => {
    expect(token(text, "#~ X-Debug: 1")).toBe("tok-comment tok-deleted");
    expect(token(text, "#~&limit=5")).toBe("tok-comment tok-deleted");
  });
});

describe("a body line that .http reads as syntax", () => {
  const source = (body: string) => `POST /x\nContent-Type: application/json\n\n${body}\n`;

  it("is a separator when the body editor warns that it starts a new request", () => {
    const body = '{\n  "a": 1,\n### not a new request\n}';
    expect(bodySyntaxWarnings(body).map((w) => w.line)).toEqual([3]);
    expect(token(source(body), "### not a new request")).toBe("tok-heading");
  });

  it("is a handler or redirect when the body editor warns that it's read as a response handler", () => {
    const body = '{\n  "a": 1,\n  > {% indented, so body %}\n}\n> {% client.log(1) %}\n>> ./out.json';
    expect(bodySyntaxWarnings(body).map((w) => w.line)).toEqual([5, 6]);
    const text = source(body);
    expect(token(text, ">", "}\n")).toBe("tok-operator");
    expect(token(text, "client")).toBe("tok-variableName");
    expect(token(text, ">>")).toBe("tok-operator");
    // An indented `>` is body text, as the core reads it, and no warning is given.
    expect(token(text, '"a"')).toBe("tok-propertyName");
    expect(token(text, "indented")).not.toBe("tok-variableName");
    expect(token(text, "{%")).not.toBe("tok-punctuation");
  });
});

describe("folding", () => {
  it("folds each ### block from the end of its first line to its last line that isn't blank", () => {
    const text = "### One\nGET /one\nAccept: */*\n\n\n### Two\nGET /two\n";
    const state = EditorState.create({ doc: text, extensions: [http()] });
    const first = state.doc.line(1);
    expect(foldable(state, first.from, first.to)).toEqual({ from: first.to, to: state.doc.line(3).to });
    const second = state.doc.line(6);
    expect(foldable(state, second.from, second.to)).toEqual({ from: second.to, to: state.doc.line(7).to });
    // A request line isn't a fold of its own.
    expect(foldable(state, state.doc.line(2).from, state.doc.line(2).to)).toBeNull();
  });
});
