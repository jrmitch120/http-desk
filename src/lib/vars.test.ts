import { describe, expect, it } from "vitest";
import shared from "../../crates/httpdesk-core/tests/fixtures/resolution-cases.json";
import type { EnvironmentSet, EnvVar, ExchangeShape, Variable } from "./types";
import { DYNAMIC_VARIABLES, envVariables, makeVarProvider, varSegments } from "./vars";
import { environmentsFor } from "./envFolders";

type EnvFile = Record<string, Record<string, string>>;
interface Case {
  case: string;
  envFiles?: { public?: EnvFile; private?: EnvFile };
  /** The same pair for folders below the root, by relative path. */
  folders?: Record<string, { public?: EnvFile; private?: EnvFile }>;
  /** The folder of the request's file (default: the root). */
  dir?: string;
  environment?: string | null;
  file?: Variable[];
  request?: Variable[];
  text: string;
  value: string;
  undefined?: string[];
  circular?: string[][];
  /** The request's Prompt variables; one with a `value` has been answered. */
  prompts?: { name: string; value?: string }[];
  asked?: string[];
  /** The file's `# @name`s; their exchanges, the core's value and its unsent/unmatched reports are the core's alone. */
  named?: string[];
}

/**
 * The environment set the core hands the frontend for a request in folder `dir`
 * (`env::load_for`): for each environment name, the nearest folder whose file
 * defines it, public and private files looked up separately; public then private,
 * a private value overriding and marking a Secret.
 */
function loaded(c: Case, dir = ""): EnvironmentSet {
  const files = (d: string) => (d ? c.folders?.[d] : c.envFiles);
  const chain = dir.split("/").filter(Boolean).map((_, i, all) => all.slice(0, i + 1).join("/"));
  chain.unshift("");
  const set: EnvironmentSet = { shared: [], environments: [], privateFileIgnored: null };
  const vars = (env: string): EnvVar[] => {
    if (env === "$shared") return set.shared;
    let e = set.environments.find((x) => x.name === env);
    if (!e) set.environments.push((e = { name: env, variables: [] }));
    return e.variables;
  };
  for (const [kind, secret] of [["public", false], ["private", true]] as const) {
    // Farthest first, so a nearer file replaces the whole environment.
    const nearest = new Map<string, Record<string, string>>();
    for (const d of chain) for (const [env, entries] of Object.entries(files(d)?.[kind] ?? {})) nearest.set(env, entries);
    for (const [env, entries] of nearest) {
      const list = vars(env);
      for (const [name, value] of Object.entries(entries)) {
        const v = list.find((x) => x.name === name);
        if (v) Object.assign(v, { value, secret: v.secret || secret });
        else list.push({ name, value, secret });
      }
    }
  }
  return set;
}

describe("what hovering a reference shows", () => {
  const set: EnvironmentSet = {
    shared: [{ name: "scheme", value: "https", secret: false }],
    environments: [
      {
        name: "dev",
        variables: [
          { name: "baseUrl", value: "{{scheme}}://{{host}}/api", secret: false },
          { name: "host", value: "dev.example", secret: false },
          { name: "token", value: "s3cret", secret: true },
          { name: "auth", value: "Bearer {{token}}", secret: false },
          { name: "a", value: "{{b}}", secret: false },
          { name: "b", value: "{{a}}", secret: false },
        ],
      },
    ],
    privateFileIgnored: null,
  };
  const provider = (requestVars: Variable[] = [], fileVars: Variable[] = requestVars, envName: string | null = "dev") =>
    makeVarProvider({ env: envVariables(set, envName), fileVars, requestVars, envName });

  it("shows the fully resolved value and where the name is defined", () => {
    expect(provider().info("baseUrl")).toEqual({
      state: "ok",
      value: "https://dev.example/api",
      secret: false,
      source: 'environment "dev"',
      definition: { kind: "env", env: "dev", name: "baseUrl" },
    });
    expect(provider().info("scheme")).toMatchObject({ state: "ok", source: "shared variables" });
  });

  it("takes the request's own declaration over one elsewhere in the file", () => {
    const own = [{ name: "host", value: "own.example" }];
    const file = [{ name: "host", value: "header.example" }, ...own, { name: "host", value: "later.example" }];
    expect(provider(own, file).info("baseUrl")).toMatchObject({ value: "https://own.example/api" });
    expect(provider(own, file).info("host")).toMatchObject({ value: "own.example", source: "this request" });
    expect(provider([], file).info("host")).toMatchObject({ value: "later.example", source: "this file" });
  });

  it("counts a value as secret when a Secret went into it", () => {
    expect(provider().info("auth")).toMatchObject({ state: "ok", secret: true });
  });

  it("reports a circular reference with its chain, not as undefined", () => {
    expect(provider().info("a")).toMatchObject({ state: "circular", chain: ["a", "b", "a"] });
    expect(provider().info("nope")).toEqual({ state: "bad", source: undefined });
    expect(provider([], [], null).info("nope")).toEqual({ state: "bad", source: "no environment selected" });
    expect(provider().info("$uuid")).toEqual({ state: "dyn" });
  });

  it("marks a Request variable of a request named in the file, and only those", () => {
    const named = makeVarProvider({ env: envVariables(set, "dev"), fileVars: [{ name: "login", value: "x" }], requestVars: [], envName: "dev", requestNames: ["login"] });
    expect(named.info("login.response.body.$.token")).toEqual({ state: "request", source: "the latest exchange of login" });
    expect(named.info("other.response.body.$.token")).toEqual({ state: "bad" });
    expect(named.info("login")).toMatchObject({ state: "ok", value: "x" });
    expect(provider([], [{ name: "login", value: "x" }]).info("login.response.body.$.token")).toEqual({ state: "bad" });
  });

  it("says where to edit the definition in use, when it has a row in the app", () => {
    const header = [{ name: "host", value: "header.example" }];
    const own = [{ name: "id", value: "7" }];
    const later = [{ name: "page", value: "2" }];
    const p = makeVarProvider({ env: envVariables(set, "dev"), fileVars: [...header, ...own, ...later], headerVars: header, requestVars: own, envName: "dev" });
    expect(p.info("token").definition).toEqual({ kind: "env", env: "dev", name: "token" });
    expect(p.info("scheme").definition).toEqual({ kind: "env", env: "$shared", name: "scheme" });
    // The header's File variable beats the environment's host: its row is in the request's Settings.
    expect(p.info("host").definition).toEqual({ kind: "file", name: "host" });
    // The request's own @id and another request's @page are edited in their request's .http source.
    expect(p.info("id").definition).toEqual({ kind: "request", name: "id" });
    expect(p.info("page").definition).toEqual({ kind: "request", name: "page" });
    expect(p.info("a").definition).toEqual({ kind: "env", env: "dev", name: "a" });
    expect(p.info("nope").definition).toBeUndefined();
  });

  it("says which folder supplies an environment value: the private file's for a Secret, else the public file's", () => {
    // What the core gives a request in api/users/: dev's public file at the root, its private one in api/.
    const nested: EnvironmentSet = {
      shared: [{ name: "version", value: "v2", secret: false }],
      sharedSource: { public: "api/users", private: null },
      environments: [
        {
          name: "dev",
          source: { public: "", private: "api" },
          variables: [
            { name: "host", value: "h", secret: false },
            { name: "token", value: "t", secret: true },
          ],
        },
      ],
      privateFileIgnored: null,
    };
    const p = makeVarProvider({ env: envVariables(nested, "dev"), fileVars: [], requestVars: [], envName: "dev" });
    expect(p.info("host").definition).toEqual({ kind: "env", env: "dev", name: "host", dir: "" });
    expect(p.info("token").definition).toEqual({ kind: "env", env: "dev", name: "token", dir: "api" });
    expect(p.info("version").definition).toEqual({ kind: "env", env: "$shared", name: "version", dir: "api/users" });
  });

  it("marks a $name the core doesn't generate as undefined", () => {
    expect(provider().info("$datetime iso8601")).toEqual({ state: "dyn" });
    expect(provider().info("$random.integer(1, 5)")).toEqual({ state: "dyn" });
    expect(provider().info("$env.HOME")).toEqual({ state: "dyn" });
    expect(provider().info("$nope")).toMatchObject({ state: "bad" });
    expect(provider().info("$env.")).toMatchObject({ state: "bad" });
  });
});

describe("what autocomplete offers after {{", () => {
  const set: EnvironmentSet = {
    shared: [
      { name: "scheme", value: "https", secret: false },
      { name: "host", value: "shared.example", secret: false },
    ],
    environments: [
      {
        name: "dev",
        variables: [
          { name: "baseUrl", value: "{{scheme}}://{{host}}/api", secret: false },
          { name: "token", value: "s3cret", secret: true },
          { name: "auth", value: "Bearer {{token}}", secret: false },
          { name: "long", value: "x".repeat(100), secret: false },
          { name: "a", value: "{{a}}", secret: false },
        ],
      },
    ],
    privateFileIgnored: null,
  };
  const provider = makeVarProvider({
    env: envVariables(set, "dev"),
    fileVars: [{ name: "host", value: "file.example" }, { name: "id", value: "7" }],
    requestVars: [{ name: "id", value: "8" }],
    envName: "dev",
  });
  const offered = provider.completions();
  const entry = (name: string) => offered.find((c) => c.name === name);

  it("shows each name's source and a preview of its resolved value", () => {
    expect(entry("baseUrl")).toEqual({ name: "baseUrl", source: "environment", preview: "https://file.example/api" });
    expect(entry("scheme")).toEqual({ name: "scheme", source: "shared", preview: "https" });
    // Declared in the file over the shared one; the request's own declaration wins.
    expect(entry("host")).toEqual({ name: "host", source: "file", preview: "file.example" });
    expect(entry("id")).toEqual({ name: "id", source: "file", preview: "8" });
    expect(offered.filter((c) => c.name === "host")).toHaveLength(1);
  });

  it("shortens a long preview", () => {
    expect(entry("long")!.preview).toBe("x".repeat(39) + "…");
  });

  it("never previews a Secret, or a value a Secret went into", () => {
    expect(entry("token")).toEqual({ name: "token", source: "environment", secret: true });
    expect(entry("auth")).toEqual({ name: "auth", source: "environment", secret: true });
    expect(JSON.stringify(offered)).not.toContain("s3cret");
  });

  it("has no preview for a circular reference", () => {
    expect(entry("a")).toEqual({ name: "a", source: "environment" });
  });

  it("lists every dynamic variable with a description and argument hints", () => {
    const dynamic = offered.filter((c) => c.source === "dynamic");
    expect(dynamic.map((c) => c.name)).toEqual(expect.arrayContaining(["$uuid", "$timestamp", "$randomInt", "$random.integer", "$random.email", "$isoTimestamp", "$datetime", "$processEnv", "$dotenv"]));
    expect(dynamic.map((c) => c.name)).toEqual(DYNAMIC_VARIABLES.map((d) => d.name));
    for (const c of dynamic) expect(c.description, c.name).toMatch(/\w{3}/);
    expect(entry("$randomInt")).toMatchObject({ args: "[min max]" });
    expect(entry("$random.integer")).toMatchObject({ args: "(from, to)" });
    expect(entry("$processEnv")).toMatchObject({ args: "NAME", required: true });
    expect(entry("$uuid")).toMatchObject({ args: "" });
  });
});

describe("what hovering a Prompt variable shows", () => {
  const env = { otp: { value: "env", secret: false, source: "dev" }, code: { value: "otp={{otp}}", secret: false, source: "dev" } };
  const prompts = [
    { name: "otp", description: "One-time code" },
    { name: "password", description: "" },
    { name: "user", description: "" },
  ];
  const provider = makeVarProvider({ env, fileVars: [], requestVars: [], envName: "dev", prompts, answers: { password: "s3cret", user: "ann" } });

  it("is asked when sent until answered, even when defined elsewhere", () => {
    expect(provider.info("otp")).toEqual({ state: "prompt", source: "a prompt: asked when sent" });
    expect(varSegments("{{code}}", provider)[0].cls).toBe("cm-var cm-var-ok");
    expect(provider.info("code")).toMatchObject({ value: "otp={{otp}}" });
  });

  it("shows a remembered value, masked for password prompts", () => {
    expect(provider.info("user")).toEqual({ state: "ok", value: "ann", secret: false, source: "a prompt, remembered in the Session" });
    expect(provider.info("password")).toMatchObject({ state: "ok", secret: true });
    expect(varSegments("{{otp}}", provider)[0].cls).toBe("cm-var cm-var-prompt");
  });

  it("is offered by autocomplete as a prompt, over a variable of the same name, never previewing a masked value", () => {
    const offered = provider.completions();
    expect(offered.filter((c) => c.name === "otp")).toEqual([{ name: "otp", source: "prompt" }]);
    expect(offered.find((c) => c.name === "user")).toEqual({ name: "user", source: "prompt", preview: "ann" });
    expect(offered.find((c) => c.name === "password")).toEqual({ name: "password", source: "prompt", secret: true });
    expect(JSON.stringify(offered)).not.toContain("s3cret");
  });
});

describe("field marks", () => {
  it("read references exactly as the resolver does, so a mark never disagrees with what's resolved", () => {
    const provider = makeVarProvider({ env: {}, fileVars: [{ name: "a", value: "x" }], requestVars: [], envName: null });
    const text = "{{a{b}} {{ a }} {{ unclosed";
    const marked = varSegments(text, provider).filter((s) => s.name !== undefined);
    expect(marked.map((s) => [s.text, s.cls])).toEqual([
      ["{{a{b}}", "cm-var cm-var-bad"],
      ["{{ a }}", "cm-var cm-var-ok"],
    ]);
    expect(provider.resolve(text).undefined).toEqual(marked.filter((s) => s.cls!.includes("bad")).map((s) => s.name));
    expect(varSegments(text, provider).map((s) => s.text).join("")).toBe(text);
  });
});

/** What the frontend picks for the case's request from what the core gives it: the root's set and each folder's. */
function requestEnvironments(c: Case): EnvironmentSet | null {
  const folders = Object.keys(c.folders ?? {}).map((dir) => ({ dir, set: loaded(c, dir) }));
  return environmentsFor(loaded(c), folders, c.dir ?? "");
}

describe("the frontend resolver agrees with the core on the shared cases", () => {
  it.each((shared.cases as Case[]).map((c) => [c.case, c] as const))("%s", (_, c) => {
    const environment = c.environment ?? null;
    const provider = makeVarProvider({
      env: envVariables(requestEnvironments(c), environment),
      fileVars: c.file ?? [],
      requestVars: c.request ?? [],
      envName: environment,
      prompts: (c.prompts ?? []).map((p) => ({ name: p.name, description: "" })),
      answers: Object.fromEntries((c.prompts ?? []).flatMap((p) => (p.value === undefined ? [] : [[p.name, p.value]]))),
      requestNames: c.named ?? [],
    });
    const r = provider.resolve(c.text);
    expect({ value: r.value, undefined: r.undefined, circular: r.circular, asked: r.asked }).toEqual({
      value: c.value,
      undefined: c.undefined ?? [],
      circular: c.circular ?? [],
      asked: c.asked ?? [],
    });
  });
});

describe("varSegments (the static rendering of a variable-aware field)", () => {
  const env = {
    baseUrl: { value: "http://127.0.0.1:8765", secret: false, source: "local" },
    token: { value: "dev-token-123", secret: true, source: "local" },
    a: { value: "{{b}}", secret: false, source: "local" },
    b: { value: "{{a}}", secret: false, source: "local" },
  };
  const provider = makeVarProvider({ env, fileVars: [{ name: "petId", value: "1" }], requestVars: [], envName: "local" });

  it("splits text into plain runs and references, each reference classed by its state", () => {
    expect(varSegments("Bearer {{token}} for {{petId}}, {{ nope }} at {{$uuid}} {{a}}!", provider)).toEqual([
      { text: "Bearer " },
      { text: "{{token}}", name: "token", cls: "cm-var cm-var-ok cm-var-secret" },
      { text: " for " },
      { text: "{{petId}}", name: "petId", cls: "cm-var cm-var-ok" },
      { text: ", " },
      { text: "{{ nope }}", name: "nope", cls: "cm-var cm-var-bad" },
      { text: " at " },
      { text: "{{$uuid}}", name: "$uuid", cls: "cm-var cm-var-dyn" },
      { text: " " },
      { text: "{{a}}", name: "a", cls: "cm-var cm-var-circular" },
      { text: "!" },
    ]);
  });

  it("is one plain run without references, and nothing for empty text", () => {
    expect(varSegments("application/json", provider)).toEqual([{ text: "application/json" }]);
    expect(varSegments("", provider)).toEqual([]);
  });

  it("leaves references plain when there is no provider", () => {
    expect(varSegments("a {{token}}", null)).toEqual([{ text: "a {{token}}" }]);
  });
});

describe("what autocomplete offers in a Request variable's path", () => {
  const login: ExchangeShape = {
    received: "2026-11-13T10:02:03.000Z",
    status: 200,
    response: {
      headers: ["Content-Type", "X-Token"],
      body: { keys: [["token", {}], ["user", { keys: [["id", {}], ["roles", { items: { keys: [["name", {}]] } }]] }]] },
    },
    request: { headers: ["X-Client"], body: { keys: [["user", {}]] } },
  };
  const provider = (exchange: ExchangeShape | null) =>
    makeVarProvider({ env: {}, fileVars: [], requestVars: [], envName: null, requestNames: ["login"], exchange: async (name) => (name === "login" ? exchange : null) });
  /** What's offered with `typed` (the reference so far) before the caret: labels, and where they replace from. */
  async function offered(p: ReturnType<typeof provider>, typed: string) {
    const c = await p.pathCompletions!(typed);
    return c && { from: c.from, labels: c.options.map((o) => o.label) };
  }

  it("offers the JSON body's keys, nested as you go", async () => {
    const p = provider(login);
    expect(await offered(p, "login.response.body.$.")).toEqual({ from: 21, labels: ["token", "user"] });
    expect(await offered(p, "login.response.body.$.user.")).toEqual({ from: 26, labels: ["id", "roles"] });
    expect(await offered(p, "login.response.body.$.user.roles[0].")).toEqual({ from: 35, labels: ["name"] });
    expect(await offered(p, "login.response.body.$.us")).toEqual({ from: 21, labels: ["user"] });
    expect(await offered(p, "login.request.body.$.")).toEqual({ from: 20, labels: ["user"] });
  });

  it("keeps the caret in the braces after a key that has keys below it, itself or in its items", async () => {
    const c = await provider(login).pathCompletions!("login.response.body.$.");
    expect(c!.options).toEqual([
      { label: "token", insert: ".token" },
      { label: "user", insert: ".user", more: true },
    ]);
    const roles = await provider(login).pathCompletions!("login.response.body.$.user.r");
    expect(roles!.options).toEqual([{ label: "roles", insert: ".roles", more: true }]);
  });

  it("offers each side's header names", async () => {
    const p = provider(login);
    expect(await offered(p, "login.response.headers.")).toEqual({ from: 23, labels: ["Content-Type", "X-Token"] });
    expect(await offered(p, "login.response.headers.tok")).toEqual({ from: 23, labels: ["X-Token"] });
    expect(await offered(p, "login.request.headers.")).toEqual({ from: 22, labels: ["X-Client"] });
  });

  it("offers response or request after the name, then body or headers, each going on to the next segment", async () => {
    const p = provider(login);
    expect(await offered(p, "login.")).toEqual({ from: 6, labels: ["response", "request"] });
    expect(await offered(p, "login.req")).toEqual({ from: 6, labels: ["request"] });
    expect(await offered(p, "login.response.")).toEqual({ from: 15, labels: ["body", "headers"] });
    const body = await p.pathCompletions!("login.response.body.");
    expect(body!.options.map((o) => [o.label, o.insert, !!o.more])).toEqual([
      ["$", "$.", true],
      ["*", "*", false],
    ]);
    expect((await p.pathCompletions!("login."))!.options[0]).toMatchObject({ insert: "response.", more: true });
  });

  it("without an exchange offers the structure but no paths, with a hint that it hasn't been sent", async () => {
    const p = provider(null);
    const hint = "login hasn't been sent in this Session";
    expect(await p.pathCompletions!("login.")).toMatchObject({ hint, options: [{ label: "response", detail: hint }, { label: "request", detail: hint }] });
    expect(await offered(p, "login.response.")).toEqual({ from: 15, labels: ["body", "headers"] });
    expect(await offered(p, "login.response.body.")).toEqual({ from: 20, labels: ["$", "*"] });
    expect(await p.pathCompletions!("login.response.body.$.")).toEqual({ from: 20, options: [], hint });
    expect(await p.pathCompletions!("login.response.headers.")).toEqual({ from: 23, options: [], hint });
  });

  it("says when a body has no JSON keys to offer", async () => {
    const p = provider({ ...login, response: { headers: [], body: null } });
    expect(await p.pathCompletions!("login.response.body.$.")).toMatchObject({ options: [], hint: "login's latest response body isn't JSON" });
  });

  it("leaves anything that isn't a named request's path to the names in scope", async () => {
    const p = provider(login);
    expect(await p.pathCompletions!("log")).toBeNull();
    expect(await p.pathCompletions!("other.response.")).toBeNull();
    expect(await p.pathCompletions!("login.resp.x")).toBeNull();
    expect(await p.pathCompletions!("login.response.cookies.")).toBeNull();
  });

  it("offers the file's named requests after {{, as requests", () => {
    const names = provider(login).completions().filter((c) => c.source === "request");
    expect(names).toEqual([{ name: "login", source: "request" }]);
  });
});
