import { describe, expect, it } from "vitest";
import { usageRows } from "./usages";
import type { Usage, UsageField } from "./types";

const inRequest = (field: UsageField, extra: Partial<Usage> = {}): Usage => ({
  kind: "request",
  path: "/ws/api/users.http",
  index: 0,
  name: "List users",
  method: "GET",
  url: "{{host}}/users",
  field,
  disabled: false,
  start: 0,
  end: 8,
  ...extra,
} as Usage);

describe("usageRows", () => {
  it("lists each field once, with its request, file and what the field is", () => {
    const rows = usageRows([
      inRequest({ kind: "url" }),
      inRequest({ kind: "url" }, { start: 10, end: 18 }),
      inRequest({ kind: "param", index: 1, name: "debug", part: "value" }, { disabled: true }),
      inRequest({ kind: "header", index: 0, name: "Authorization", part: "value" }),
      inRequest({ kind: "auth", part: "token" }),
      inRequest({ kind: "body" }),
      inRequest({ kind: "variable", index: 0, name: "me" }),
    ]);
    expect(rows.map((r) => [r.title, r.method, r.where, r.disabled])).toEqual([
      ["List users", "GET", "users.http · URL", false],
      ["List users", "GET", "users.http · Param debug", true],
      ["List users", "GET", "users.http · Header Authorization", false],
      ["List users", "GET", "users.http · Auth token", false],
      ["List users", "GET", "users.http · Body", false],
      ["List users", "GET", "users.http · File variable @me", false],
    ]);
  });

  it("names File variables at the top of a file and environment values", () => {
    const rows = usageRows([
      { kind: "fileVariable", path: "/ws/a.http", index: 0, name: "base", start: 0, end: 8 },
      { kind: "environment", path: "/ws/http-client.env.json", env: "$shared", name: "api", secret: false, start: 0, end: 8 },
      { kind: "environment", path: "/ws/http-client.private.env.json", env: "dev", name: "token", secret: true, start: 0, end: 8 },
    ]);
    expect(rows.map((r) => [r.title, r.method, r.where])).toEqual([
      ["@base", undefined, "a.http · File variable"],
      ["api", undefined, "Shared variables"],
      ["token", undefined, 'Environment "dev" · Secret'],
    ]);
  });
});
