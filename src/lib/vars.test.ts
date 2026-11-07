import { describe, expect, it } from "vitest";
import shared from "../../crates/httpdesk-core/tests/fixtures/resolution-cases.json";
import type { EnvironmentSet, EnvVar, Variable } from "./types";
import { envVariables, makeVarProvider, varSegments } from "./vars";

type EnvFile = Record<string, Record<string, string>>;
interface Case {
  case: string;
  envFiles?: { public?: EnvFile; private?: EnvFile };
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
}

/**
 * The environment set the core's `load_environments` hands the frontend for these
 * files: public then private, a private value overriding and marking a Secret.
 */
function loaded(files: Case["envFiles"]): EnvironmentSet {
  const set: EnvironmentSet = { shared: [], environments: [], privateFileIgnored: null };
  const vars = (env: string): EnvVar[] => {
    if (env === "$shared") return set.shared;
    let e = set.environments.find((x) => x.name === env);
    if (!e) set.environments.push((e = { name: env, variables: [] }));
    return e.variables;
  };
  for (const [file, secret] of [[files?.public, false], [files?.private, true]] as const) {
    for (const [env, entries] of Object.entries(file ?? {})) {
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
    expect(provider().info("baseUrl")).toEqual({ state: "ok", value: "https://dev.example/api", secret: false, source: 'environment "dev"' });
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
    expect(provider.info("user")).toEqual({ state: "ok", value: "ann", secret: false, source: "a prompt, remembered until the app quits" });
    expect(provider.info("password")).toMatchObject({ state: "ok", secret: true });
    expect(varSegments("{{otp}}", provider)[0].cls).toBe("cm-var cm-var-prompt");
  });
});

describe("the frontend resolver agrees with the core on the shared cases", () => {
  it.each((shared.cases as Case[]).map((c) => [c.case, c] as const))("%s", (_, c) => {
    const environment = c.environment ?? null;
    const provider = makeVarProvider({
      env: envVariables(loaded(c.envFiles), environment),
      fileVars: c.file ?? [],
      requestVars: c.request ?? [],
      envName: environment,
      prompts: (c.prompts ?? []).map((p) => ({ name: p.name, description: "" })),
      answers: Object.fromEntries((c.prompts ?? []).flatMap((p) => (p.value === undefined ? [] : [[p.name, p.value]]))),
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
