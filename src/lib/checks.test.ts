import { describe, expect, it } from "vitest";
import { newRequest } from "./http";
import { makeVarProvider, type Scope } from "./vars";
import { bodyFilePaths, isNote, quickFixes, requestChecks, undefinedVariables, type SourceFindings } from "./checks";
import type { BodyFile, EnvironmentSet, Problem, Request } from "./types";

const scope = (over: Partial<Scope> = {}): Scope => ({ env: {}, fileVars: [], requestVars: [], envName: "dev", ...over });
const request = (edit: (r: Request) => void): Request => {
  const r = newRequest();
  edit(r);
  return r;
};

describe("Undefined variables of a request", () => {
  it("names an undefined variable in a header value and the section it is used in", () => {
    const req = request((r) => r.headers.items.push({ enabled: true, name: "Authorization", value: "Bearer {{token}}" }));
    expect(undefinedVariables(req, makeVarProvider(scope()))).toEqual([{ name: "token", sections: ["headers"] }]);
  });

  it("lists each one once, in the order they first appear, with every section it is used in", () => {
    const req = request((r) => {
      r.url = "{{baseUrl}}/users/{{id}}";
      r.query.items.push({ enabled: true, name: "page", value: "{{page}}" });
      r.headers.items.push({ enabled: true, name: "X-Id", value: "{{id}}" });
      r.auth = { ...r.auth, kind: "basic", username: "{{user}}", password: "{{password}}" };
      r.body = { enabled: true, mode: "json", text: '{ "id": "{{id}}", "page": {{page}} }' };
    });
    expect(undefinedVariables(req, makeVarProvider(scope()))).toEqual([
      { name: "baseUrl", sections: ["url"] },
      { name: "id", sections: ["url", "headers", "body"] },
      { name: "page", sections: ["params", "body"] },
      { name: "user", sections: ["auth"] },
      { name: "password", sections: ["auth"] },
    ]);
  });

  it("finds them in every kind of auth and body", () => {
    const sections = (edit: (r: Request) => void) => undefinedVariables(request(edit), makeVarProvider(scope())).map((u) => [u.name, u.sections]);
    expect(sections((r) => (r.auth = { ...r.auth, kind: "bearer", token: "{{token}}" }))).toEqual([["token", ["auth"]]]);
    expect(sections((r) => (r.auth = { ...r.auth, kind: "apiKey", keyName: "X-Key", keyValue: "{{key}}" }))).toEqual([["key", ["auth"]]]);
    expect(sections((r) => (r.body = { enabled: true, mode: "formUrlEncoded", text: "a={{a}}\n&b=1" }))).toEqual([["a", ["body"]]]);
    expect(sections((r) => (r.body = { enabled: true, mode: "file", text: "< ./{{dir}}/body.json" }))).toEqual([["dir", ["body"]]]);
  });

  it("leaves out what isn't sent: disabled rows, sections, parts and fields", () => {
    const names = (edit: (r: Request) => void) => undefinedVariables(request(edit), makeVarProvider(scope())).map((u) => u.name);
    expect(names((r) => r.headers.items.push({ enabled: false, name: "X-A", value: "{{a}}" }))).toEqual([]);
    expect(names((r) => r.query.items.push({ enabled: true, name: "", value: "{{a}}" }))).toEqual([]);
    expect(
      names((r) => {
        r.query = { enabled: false, items: [{ enabled: true, name: "a", value: "{{a}}" }] };
        r.headers = { enabled: false, items: [{ enabled: true, name: "X-A", value: "{{a}}" }] };
      }),
    ).toEqual([]);
    expect(names((r) => (r.auth = { ...r.auth, enabled: false, kind: "bearer", token: "{{a}}" }))).toEqual([]);
    expect(names((r) => (r.auth = { ...r.auth, kind: "none", token: "{{a}}" }))).toEqual([]);
    expect(names((r) => (r.body = { enabled: false, mode: "json", text: "{{a}}" }))).toEqual([]);
    expect(names((r) => (r.body = { enabled: true, mode: "formUrlEncoded", text: "b={{b}}\n#~ &a={{a}}\n# {{c}}\n// {{d}}" }))).toEqual(["b"]);
    const multipart = ["--B", 'Content-Disposition: form-data; name="b"', "", "{{b}}", "#~ --B", '#~ Content-Disposition: form-data; name="a"', "#~", "#~ {{a}}", "--B--"];
    expect(names((r) => (r.body = { enabled: true, mode: "multipart", text: multipart.join("\n") }))).toEqual(["b"]);
  });

  it("reads an API key's name only where it is resolved: in the query, not as a header name", () => {
    const names = (keyLocation: "header" | "query") =>
      undefinedVariables(request((r) => (r.auth = { ...r.auth, kind: "apiKey", keyLocation, keyName: "{{n}}", keyValue: "v" })), makeVarProvider(scope())).map((u) => u.name);
    expect(names("header")).toEqual([]);
    expect(names("query")).toEqual(["n"]);
  });

  it("counts a name missing behind a defined one, but not Circular references, Prompt variables or dynamic variables", () => {
    const req = request((r) => {
      r.url = "{{baseUrl}}/{{a}}/{{asked}}/{{$uuid}}/{{answered}}";
      r.directives.push({ name: "prompt", value: "asked" }, { name: "prompt", value: "answered" });
    });
    const env = {
      baseUrl: { value: "https://{{host}}", secret: false, source: "dev" },
      a: { value: "{{b}}", secret: false, source: "dev" },
      b: { value: "{{a}}", secret: false, source: "dev" },
    };
    const prompts = [{ name: "asked", description: "" }, { name: "answered", description: "" }];
    const provider = makeVarProvider(scope({ env, prompts, answers: { answered: "{{nope}}" } }));
    expect(undefinedVariables(req, provider)).toEqual([{ name: "host", sections: ["url"] }]);
  });
});

describe("quick fixes for an Undefined variable", () => {
  const set: EnvironmentSet = {
    shared: [],
    environments: [
      { name: "local", variables: [{ name: "token", value: "t", secret: true }] },
      { name: "staging", variables: [] },
      { name: "prod", variables: [{ name: "token", value: "p", secret: true }] },
    ],
    privateFileIgnored: true,
  };

  it("offers adding it to the selected environment or as a File variable, and selecting the first environment that defines it", () => {
    expect(quickFixes("token", set, "staging")).toEqual([
      { kind: "addToEnvironment", env: "staging" },
      { kind: "addFileVariable" },
      { kind: "selectEnvironment", env: "local" },
    ]);
  });

  it("adds it in the folder whose env files supply the selected environment to the request", () => {
    const nested: EnvironmentSet = { ...set, environments: [{ name: "staging", source: { public: "api" }, variables: [] }] };
    expect(quickFixes("token", nested, "staging")[0]).toEqual({ kind: "addToEnvironment", env: "staging", dir: "api" });
  });

  it("offers selecting an environment when none is selected", () => {
    expect(quickFixes("token", set, null)).toEqual([{ kind: "addFileVariable" }, { kind: "selectEnvironment", env: "local" }]);
  });

  it("offers no environment to select when none defines it", () => {
    expect(quickFixes("other", set, "staging")).toEqual([{ kind: "addToEnvironment", env: "staging" }, { kind: "addFileVariable" }]);
  });

  it("offers nothing for a name that can't be defined: an unknown dynamic variable, or one a variable line can't hold", () => {
    expect(quickFixes("$nope", set, "staging")).toEqual([]);
    expect(quickFixes("a b", set, "staging")).toEqual([]);
  });
});

describe("an environment the request's folder doesn't define", () => {
  // The request's own environments (its folder's): `qa` exists elsewhere in the workspace only.
  const set: EnvironmentSet = {
    shared: [],
    environments: [{ name: "local", variables: [{ name: "baseUrl", value: "http://localhost", secret: false }] }],
    privateFileIgnored: null,
  };
  const req = request((r) => (r.url = "{{baseUrl}}/users"));
  const checks = (envName: string | null) => requestChecks(req, makeVarProvider(scope({ envName, env: {} })), set, envName, "api/users");

  it("is listed first, naming the folder, with a way to choose another environment", () => {
    expect(checks("qa")).toEqual([
      { kind: "envMissing", env: "qa", dir: "api/users", fixes: [{ kind: "chooseEnvironment" }] },
      // Nothing is offered to be added to an environment the folder doesn't have.
      { kind: "undefined", name: "baseUrl", sections: ["url"], fixes: [{ kind: "addFileVariable" }, { kind: "selectEnvironment", env: "local" }] },
    ]);
  });

  it("isn't listed when the folder defines it or no environment is selected", () => {
    expect(checks("local").map((c) => c.kind)).toEqual(["undefined"]);
    expect(checks(null).map((c) => c.kind)).toEqual(["undefined"]);
  });
});

describe("a # @name another request in the file also has", () => {
  const named = (name: string) => request((r) => r.directives.push({ name: "name", value: name }));
  const checks = (req: Request, file: Request[]) => requestChecks(req, makeVarProvider(scope()), null, null, "", file).filter((c) => c.kind === "duplicateName");

  it("is flagged on each of them, naming it and counting the others", () => {
    const [a, b, c] = [named("login"), named(" login "), named("me")];
    expect(checks(a, [a, b, c])).toEqual([{ kind: "duplicateName", name: "login", others: 1 }]);
    expect(checks(b, [a, b, c])).toEqual([{ kind: "duplicateName", name: "login", others: 1 }]);
    expect(checks(c, [a, b, c])).toEqual([]);
    expect(checks(a, [a, b, named("login")])).toEqual([{ kind: "duplicateName", name: "login", others: 2 }]);
  });

  it("isn't flagged for an unnamed request, or a name given only by ###", () => {
    const unnamed = request(() => {});
    const titled = request((r) => (r.name = "login"));
    expect(checks(unnamed, [unnamed, request(() => {})])).toEqual([]);
    expect(checks(titled, [titled, named("login")])).toEqual([]);
  });
});

describe("the note that Rider refuses a Request variable", () => {
  const checksOf = (req: Request) => requestChecks(req, makeVarProvider(scope({ requestNames: ["login", "me"] })), null, null);
  const notes = (req: Request) => checksOf(req).filter((c) => c.kind === "riderRefuses");

  it("is there whenever a request sends one, naming the first request read", () => {
    const req = request((r) => {
      r.url = "https://example.com/{{me.response.body.$.id}}";
      r.headers.items.push({ enabled: true, name: "Authorization", value: "Bearer {{login.response.body.$.token}}" });
    });
    expect(notes(req)).toEqual([{ kind: "riderRefuses", name: "me" }]);
  });

  it("isn't there for a request with none, or with one only in a disabled header", () => {
    expect(notes(request((r) => (r.url = "https://example.com/{{login}}")))).toEqual([]);
    expect(notes(request((r) => r.headers.items.push({ enabled: false, name: "X", value: "{{login.response.body.$.token}}" })))).toEqual([]);
  });

  it("is a note, listed after the problems", () => {
    const req = request((r) => (r.url = "{{base}}/{{login.response.body.$.id}}"));
    expect(checksOf(req).map((c) => [c.kind, isNote(c)])).toEqual([
      ["undefined", false],
      ["riderRefuses", true],
    ]);
  });
});

describe("problems reading the request's source", () => {
  // As the core reports them (`request_problems`), placed in the request's source.
  const unparseable: Problem = { line: 2, column: 1, severity: "error", code: "unparseable-request-line", message: "Can't read this request line" };
  const unknown: Problem = { line: 1, column: 3, severity: "warning", code: "unknown-directive", message: "Unknown directive @nmae" };
  const missing = (path: string, line = 5): BodyFile => ({ path, missing: { line, column: 1, severity: "error", code: "missing-file", message: `${path} doesn't exist` } });
  const checksOf = (req: Request, found: SourceFindings, env: Scope["env"] = {}) => requestChecks(req, makeVarProvider(scope({ env })), null, null, "", [req], found);
  const exists = (answers: Record<string, boolean>) => (path: string) => answers[path];

  it("lists each of the parser's problems, in the order of their lines, before the other checks", () => {
    const req = request((r) => (r.url = "https://example.com/{{id}}"));
    const checks = checksOf(req, { read: { problems: [unparseable, unknown], files: [] } });
    expect(checks.map((c) => c.kind)).toEqual(["problem", "problem", "undefined"]);
    expect(checks.slice(0, 2)).toEqual([
      { kind: "problem", problem: unknown },
      { kind: "problem", problem: unparseable },
    ]);
    expect(checks.every((c) => !isNote(c))).toBe(true);
  });

  it("goes away once the request reads cleanly", () => {
    const req = request(() => {});
    expect(checksOf(req, { read: { problems: [unparseable], files: [] } })).toHaveLength(1);
    expect(checksOf(req, { read: { problems: [], files: [] } })).toEqual([]);
    // Nothing until the core has answered.
    expect(checksOf(req, {})).toEqual([]);
  });

  it("flags a body file the shell says doesn't exist, and not once it does, or before it has answered", () => {
    const req = request(() => {});
    const read = { problems: [], files: [missing("./payload.json")] };
    expect(checksOf(req, { read, exists: exists({ "./payload.json": false }) })).toEqual([{ kind: "problem", problem: read.files[0].missing }]);
    expect(checksOf(req, { read, exists: exists({ "./payload.json": true }) })).toEqual([]);
    expect(checksOf(req, { read, exists: exists({}) })).toEqual([]);
    expect(checksOf(req, { read })).toEqual([]);
  });

  it("asks about a body file by its path with variables resolved, and not at all while one is undefined", () => {
    const read = { problems: [], files: [missing("./{{dir}}/payload.json"), missing("./{{nope}}.json", 6)] };
    const env = { dir: { value: "fixtures", secret: false, source: "dev" } };
    expect(bodyFilePaths(read, makeVarProvider(scope({ env })))).toEqual([{ file: read.files[0], path: "./fixtures/payload.json" }]);
    const req = request(() => {});
    expect(checksOf(req, { read, exists: exists({ "./fixtures/payload.json": false }) }, env)).toEqual([{ kind: "problem", problem: read.files[0].missing }]);
  });
});
