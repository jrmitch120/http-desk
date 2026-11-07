import { describe, expect, it } from "vitest";
import { newRequest } from "./http";
import { renameInEnvironments, renameInFile, renameNameError, renamePreview, renameScope } from "./rename";
import type { EnvironmentSet, HttpFile, Request, Usage, UsageField } from "./types";

const PATH = "/ws/api/users.http";

function fileWith(...requests: Request[]): HttpFile {
  return { header: { comments: [], variables: [], raw: null }, requests, trailing: "", lineEnding: "lf", bom: false };
}

/** A usage of `{{host}}` in `field` of the file's request `index`, at `start`..`end`. */
function inRequest(req: Request, index: number, field: UsageField, start: number, end: number): Usage {
  return { kind: "request", path: PATH, index, name: req.name, method: req.method, url: req.url, field, disabled: false, start, end };
}

describe("renameInFile", () => {
  it("rewrites each reference where Find usages found it, keeping spacing and everything around it", () => {
    const req = { ...newRequest("List users"), url: "{{host}}/users?x={{ host }}" };
    const f = fileWith(req);
    renameInFile(f, [inRequest(req, 0, { kind: "url" }, 0, 8), inRequest(req, 0, { kind: "url" }, 17, 27)], "host", "apiHost");
    expect(f.requests[0].url).toBe("{{apiHost}}/users?x={{ apiHost }}");
  });

  it("reaches every field a reference can be in", () => {
    const req: Request = {
      ...newRequest("Login"),
      url: "https://x/login",
      variables: [{ name: "me", value: "{{host}}/me" }],
      query: { enabled: true, items: [{ enabled: false, name: "{{host}}", value: "a{{host}}" }] },
      headers: { enabled: true, items: [{ enabled: true, name: "X-Host", value: "{{host}}" }] },
      auth: { ...newRequest().auth, kind: "basic", username: "u-{{host}}", password: "{{host}}" },
      body: { enabled: true, mode: "json", text: '{"h": "{{host}}"}\n#~ {{host}}' },
    };
    const f = fileWith(newRequest("Other"), req);
    const at = (field: UsageField, start: number) => inRequest(req, 1, field, start, start + 8);
    renameInFile(
      f,
      [
        at({ kind: "variable", index: 0, name: "me" }, 0),
        at({ kind: "param", index: 0, name: "{{host}}", part: "name" }, 0),
        at({ kind: "param", index: 0, name: "{{host}}", part: "value" }, 1),
        at({ kind: "header", index: 0, name: "X-Host", part: "value" }, 0),
        at({ kind: "auth", part: "username" }, 2),
        at({ kind: "auth", part: "password" }, 0),
        at({ kind: "body" }, 7),
        at({ kind: "body" }, 21),
      ],
      "host",
      "h2",
    );
    const r = f.requests[1];
    expect(r.variables[0].value).toBe("{{h2}}/me");
    expect([r.query.items[0].name, r.query.items[0].value]).toEqual(["{{h2}}", "a{{h2}}"]);
    expect(r.headers.items[0].value).toBe("{{h2}}");
    expect([r.auth.username, r.auth.password]).toEqual(["u-{{h2}}", "{{h2}}"]);
    expect(r.body.text).toBe('{"h": "{{h2}}"}\n#~ {{h2}}');
    expect(f.requests[0]).toEqual(newRequest("Other"));
  });

  it("rewrites File variables at the top of the file", () => {
    const f = fileWith(newRequest("A"));
    f.header.variables = [
      { name: "base", value: "https://x" },
      { name: "api", value: "{{host}}/{{ host }}" },
    ];
    renameInFile(
      f,
      [
        { kind: "fileVariable", path: PATH, index: 1, name: "api", start: 0, end: 8 },
        { kind: "fileVariable", path: PATH, index: 1, name: "api", start: 9, end: 19 },
      ],
      "host",
      "server",
    );
    expect(f.header.variables).toEqual([
      { name: "base", value: "https://x" },
      { name: "api", value: "{{server}}/{{ server }}" },
    ]);
  });

  it("finds a request that moved by its name, method and URL, and skips text that no longer holds the reference", () => {
    const req = { ...newRequest("Moved"), url: "{{host}}/m" };
    const usage = inRequest(req, 0, { kind: "url" }, 0, 8);
    const stale = { ...newRequest("Stale"), url: "https://x/{{other}}" };
    const f = fileWith({ ...newRequest("New"), url: "{{host}}/new" }, req, stale);
    renameInFile(f, [usage, inRequest(stale, 2, { kind: "url" }, 10, 18)], "host", "h");
    expect(f.requests.map((r) => r.url)).toEqual(["{{host}}/new", "{{h}}/m", "https://x/{{other}}"]);
  });
});

describe("renameInEnvironments", () => {
  it("renames the variable in Shared and every environment, Secrets staying Secrets, and rewrites references in values", () => {
    const set: EnvironmentSet = {
      shared: [{ name: "token", value: "shared-t", secret: false }],
      environments: [
        { name: "dev", variables: [{ name: "token", value: "dev-t", secret: true }, { name: "auth", value: "Bearer {{token}}", secret: false }] },
        { name: "prod", variables: [{ name: "port", value: "443", secret: false, jsonType: "number" }] },
      ],
      privateFileIgnored: true,
    };
    renameInEnvironments(
      set,
      [{ kind: "environment", path: "/ws/http-client.env.json", env: "dev", name: "auth", secret: false, start: 7, end: 16 }],
      "token",
      "apiToken",
    );
    expect(set).toEqual({
      shared: [{ name: "apiToken", value: "shared-t", secret: false }],
      environments: [
        { name: "dev", variables: [{ name: "apiToken", value: "dev-t", secret: true }, { name: "auth", value: "Bearer {{apiToken}}", secret: false }] },
        { name: "prod", variables: [{ name: "port", value: "443", secret: false, jsonType: "number" }] },
      ],
      privateFileIgnored: true,
    });
  });

  it("rewrites a reference in the renamed variable's own value", () => {
    const set: EnvironmentSet = { shared: [{ name: "a", value: "x{{a}}", secret: false }], environments: [], privateFileIgnored: null };
    renameInEnvironments(set, [{ kind: "environment", path: "/ws/http-client.env.json", env: "$shared", name: "a", secret: false, start: 1, end: 6 }], "a", "b");
    expect(set.shared).toEqual([{ name: "b", value: "x{{b}}", secret: false }]);
  });
});

describe("renameNameError", () => {
  const set: EnvironmentSet = {
    shared: [{ name: "version", value: "v1", secret: false }],
    environments: [{ name: "dev", variables: [{ name: "host", value: "h", secret: false }, { name: "token", value: "t", secret: true }] }],
    privateFileIgnored: null,
  };

  it("refuses a name that already exists in Shared or an environment", () => {
    expect(renameNameError("token", "host", set)).toBe("dev already has a variable named token");
    expect(renameNameError("version", "host", set)).toBe("The shared variables already have a variable named version");
  });

  it("refuses names a reference can't use, and accepts a new one", () => {
    expect(renameNameError("$x", "host", set)).toBe("A name starting with $ is read as a dynamic variable");
    expect(renameNameError("a b", "host", set)).toBe("Variable names can only use letters, digits, _, -, . and $");
    expect(renameNameError("server", "host", set)).toBeNull();
    // Nothing typed yet, or the name unchanged: no error to show (and nothing to rename).
    expect(renameNameError("", "host", set)).toBeNull();
    expect(renameNameError("host", "host", set)).toBeNull();
  });
});

describe("renamePreview", () => {
  it("lists the affected files in the order found, with how many requests (and other places) in each", () => {
    const a = { ...newRequest("A"), url: "{{host}}" };
    const b = { ...newRequest("B"), url: "{{host}}" };
    const other = "/ws/b.http";
    expect(
      renamePreview([
        inRequest(a, 0, { kind: "url" }, 0, 8),
        inRequest(a, 0, { kind: "body" }, 0, 8),
        inRequest(b, 1, { kind: "url" }, 0, 8),
        { kind: "fileVariable", path: other, index: 0, name: "api", start: 0, end: 8 },
        { ...inRequest(a, 3, { kind: "url" }, 0, 8), path: other },
        { kind: "environment", path: "/ws/http-client.env.json", env: "dev", name: "x", secret: false, start: 0, end: 8 },
        { kind: "environment", path: "/ws/http-client.env.json", env: "$shared", name: "x", secret: false, start: 0, end: 8 },
        { kind: "environment", path: "/ws/http-client.private.env.json", env: "dev", name: "t", secret: true, start: 0, end: 8 },
      ]),
    ).toEqual([
      { path: PATH, detail: "2 requests" },
      { path: other, detail: "1 request, 1 File variable" },
      { path: "/ws/http-client.env.json", detail: "2 environment values" },
      { path: "/ws/http-client.private.env.json", detail: "1 environment value" },
    ]);
  });
});

describe("renameScope", () => {
  const at = (path: string): Usage => ({ ...inRequest({ ...newRequest("R"), url: "{{host}}" }, 0, { kind: "url" }, 0, 8), path });
  const value = (path: string): Usage => ({ kind: "environment", path, env: "dev", name: "url", secret: false, start: 0, end: 8 });
  const fileVar = (path: string): Usage => ({ kind: "fileVariable", path, index: 0, name: "api", start: 0, end: 8 });

  it("renaming in the root's env files: every .http file, except below a nearer folder whose own env files define the name (ADR-0004)", () => {
    const usages = [
      at("/ws/a.http"),
      at("/ws/api/b.http"),
      at("/ws/api/v2/c.http"),
      fileVar("/ws/web/d.http"),
      at("/ws/apis/e.http"),
      value("/ws/http-client.env.json"),
      value("/ws/api/http-client.env.json"),
    ];
    // api/ has env files defining `host`; web/ has env files that don't.
    expect(renameScope(usages, { root: "/ws", dir: "", shadowing: ["api"] }).map((u) => u.path)).toEqual([
      "/ws/a.http",
      "/ws/web/d.http",
      "/ws/apis/e.http",
      "/ws/http-client.env.json",
    ]);
  });

  it("renaming in a nested folder's env files: only .http files under it, and only that folder's env values", () => {
    const usages = [at("/ws/a.http"), at("/ws/api/b.http"), at("/ws/api/v2/c.http"), at("/ws/api/v3/x/d.http"), value("/ws/http-client.env.json"), value("/ws/api/http-client.private.env.json")];
    expect(renameScope(usages, { root: "/ws", dir: "api", shadowing: ["api/v3"] }).map((u) => u.path)).toEqual([
      "/ws/api/b.http",
      "/ws/api/v2/c.http",
      "/ws/api/http-client.private.env.json",
    ]);
  });
});
