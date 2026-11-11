// Dev-only: lets the UI run in a plain browser (`pnpm dev`, open localhost:1420)
// for visual testing. Fixtures are produced by the real Rust parser
// (`cargo run -p httpdesk-core --example dump -- file.http`). Never bundled in
// production builds (imported behind `import.meta.env.DEV`).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import pets from "./pets.json";
import jetbrains from "./jetbrains.json";
import { base64DecodedLength, promptMasked, requestPrompts, segments } from "../lib/http";
import { currentOS, forceOS } from "../lib/platform";
import capabilities from "../../src-tauri/capabilities/default.json";
import { envVariables, isDynamic, makeVarProvider, MASK, SECRET_CLOSE, SECRET_OPEN } from "../lib/vars";
import type { AuthPart, EnvironmentSet, JsonShape, Request, ResponseCookie, ResponseKind, SendError, SendErrorKind } from "../lib/types";

/** What the shell rejects with for a response id whose body has been released. */
const RESPONSE_GONE = "Response is no longer available";

const ROOT = "/demo";
const files: Record<string, unknown> = {
  [`${ROOT}/api/pets.http`]: pets,
  [`${ROOT}/samples/jetbrains.http`]: jetbrains,
};
// `?platform=mac|windows|linux` makes the app behave as on that OS (shortcut keys and hints),
// whatever the browser runs on.
forceOS(new URLSearchParams(location.search).get("platform"));
// `?prompts=otp One-time code;password` declares Prompt variables (`# @prompt …`) on pets.http's first request.
const promptsParam = new URLSearchParams(location.search).get("prompts");
if (promptsParam) {
  const withPrompts = structuredClone(pets);
  (withPrompts.requests[0] as { directives: unknown[] }).directives = promptsParam.split(";").map((value) => ({ name: "prompt", value }));
  files[`${ROOT}/api/pets.http`] = withPrompts;
}
// `?requestVars=1` declares File variables inside requests: List pets' own `@page = 2` and
// `@size = 10`, and Create pet's `@kind = cat`.
if (new URLSearchParams(location.search).get("requestVars") === "1") {
  const withVars = structuredClone(files[`${ROOT}/api/pets.http`] as typeof pets);
  (withVars.requests[0] as { variables: unknown[] }).variables = [
    { name: "page", value: "2" },
    { name: "size", value: "10" },
  ];
  (withVars.requests[1] as { variables: unknown[] }).variables = [{ name: "kind", value: "cat" }];
  files[`${ROOT}/api/pets.http`] = withVars;
}
const tree = {
  name: "demo",
  path: ROOT,
  kind: "dir",
  children: [
    { name: "api", path: `${ROOT}/api`, kind: "dir", children: [{ name: "pets.http", path: `${ROOT}/api/pets.http`, kind: "file" }] },
    { name: "samples", path: `${ROOT}/samples`, kind: "dir", children: [{ name: "jetbrains.http", path: `${ROOT}/samples/jetbrains.http`, kind: "file" }] },
  ],
};
let envSet = {
  shared: [{ name: "version", value: "v1", secret: false }],
  environments: [
    { name: "local", variables: [{ name: "baseUrl", value: "http://127.0.0.1:8765", secret: false }, { name: "token", value: "dev-token-123", secret: true }] },
    { name: "staging", variables: [{ name: "baseUrl", value: "https://staging.example.com", secret: false }] },
  ],
  // `?privateFileIgnored=false` simulates a private env file git doesn't ignore.
  privateFileIgnored: new URLSearchParams(location.search).get("privateFileIgnored") !== "false",
};
// `?folderEnvs=1`: api/ has env files of its own (ADR-0004). Its public file defines `local`
// with its own baseUrl (the root's private `local` token still applies: private files are
// looked up separately) and `qa`, which no other folder defines.
const folderEnvs = new URLSearchParams(location.search).get("folderEnvs") === "1";
type MockSet = typeof envSet;
type MockSource = { public: string | null; private: string | null };
type MockEnvVar = { name: string; value: string; secret: boolean };
/** Each folder's own pair of env files below the root, by folder relative to the root (the root's is `envSet`). */
const folderPairs: Record<string, MockSet> = folderEnvs
  ? {
      api: {
        shared: [],
        environments: [
          { name: "local", variables: [{ name: "baseUrl", value: "http://127.0.0.1:9001", secret: false }] },
          { name: "qa", variables: [{ name: "baseUrl", value: "https://qa.example.com", secret: false }] },
        ],
        privateFileIgnored: true,
      },
    }
  : {};
const pairOf = (dir: string): MockSet | undefined => (dir ? folderPairs[dir] : envSet);
/**
 * A rough `env::load_for`: for each environment (and `$shared`) the nearest folder of
 * `chain` whose public part defines it (listed with a shareable value, or with no
 * values at all) and the nearest whose private part does (a Secret), private values
 * over public ones. `label` names the folders in `source` (`load_environments` gives a
 * pair's own folder as "").
 */
function loadFor(chain: string[], label = (d: string) => d): MockSet & { sharedSource?: MockSource } {
  const definesPublic = (vars: MockEnvVar[] | undefined, env: boolean) => !!vars && (vars.some((v) => !v.secret) || (env && !vars.some((v) => v.secret)));
  const definesPrivate = (vars: MockEnvVar[] | undefined) => !!vars?.some((v) => v.secret);
  const pick = (get: (s: MockSet) => MockEnvVar[] | undefined, env: boolean) => {
    const of = (d: string) => {
      const pair = pairOf(d);
      return pair && get(pair);
    };
    const pub = chain.find((d) => definesPublic(of(d), env));
    const priv = chain.find((d) => definesPrivate(of(d)));
    if (pub === undefined && priv === undefined) return null;
    const vars: MockEnvVar[] = pub === undefined ? [] : of(pub)!.filter((v) => !v.secret).map((v) => ({ ...v }));
    for (const v of priv === undefined ? [] : of(priv)!.filter((v) => v.secret)) {
      const i = vars.findIndex((x) => x.name === v.name);
      if (i >= 0) vars[i] = { ...v };
      else vars.push({ ...v });
    }
    return { vars, source: { public: pub === undefined ? null : label(pub), private: priv === undefined ? null : label(priv) } };
  };
  const names = [...new Set([...chain].reverse().flatMap((d) => pairOf(d)?.environments.map((e) => e.name) ?? []))];
  const shared = pick((s) => s.shared, false);
  return {
    shared: shared?.vars ?? [],
    ...(shared ? { sharedSource: shared.source } : {}),
    environments: names.flatMap((name) => {
      const e = pick((s) => s.environments.find((e) => e.name === name)?.variables, true);
      return e ? [{ name, variables: e.vars, source: e.source }] : [];
    }),
    privateFileIgnored: pairOf(chain[0])?.privateFileIgnored ?? envSet.privateFileIgnored,
  };
}
/** The folders a request in `dir` looks in, nearest first, ending at the root. */
const chainOf = (dir: string) => [...dir.split("/").filter(Boolean).map((_, i, a) => a.slice(0, a.length - i).join("/")), ""];
/** What `load_folder_environments` gives: each folder below the root with env files, with its requests' environments. */
function folderEnvironments() {
  return Object.keys(folderPairs)
    .sort()
    .map((dir) => ({ dir, set: loadFor(chainOf(dir)) }));
}
/** The environments of a request in the file at `path`: its nearest folder's with env files, else the root's. */
const envSetFor = (path: string | null) =>
  folderEnvironments()
    .filter((f) => path?.startsWith(`${ROOT}/${f.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]?.set ?? envSet;
type PreviewArgs = {
  request: Request;
  filePath: string | null;
  fileVariables: { name: string; value: string }[];
  environment: string | null;
  promptValues?: Record<string, string>;
};
/**
 * A rough stand-in for the core's `exec::preview` (tested for real in Rust), resolving
 * through the frontend's resolver (`makeVarProvider`, kept in step with the core's):
 * dynamic variables kept as written; each value a Secret went into between the Secret
 * marks; a masked prompted value masked, unanswered ones kept as written; query values
 * percent-encoded; the Content-Type the body implies; the default headers.
 */
function previewRequest({ request: r, filePath, fileVariables, environment, promptValues = {} }: PreviewArgs) {
  const own = envSetFor(filePath) as EnvironmentSet;
  const prompts = requestPrompts(r);
  const vars = makeVarProvider({ env: envVariables(own, environment), fileVars: fileVariables, requestVars: r.variables, envName: environment, prompts, answers: promptValues });
  const undefinedNames = new Set<string>();
  const circular: string[][] = [];
  // Reference by reference, as the core marks each one a Secret went into.
  const resolve = (text: string): string =>
    segments(text)
      .map(({ text: whole, ref }) => {
        if (ref === undefined) return whole;
        if (prompts.some((p) => p.name === ref) && Object.hasOwn(promptValues, ref) && promptMasked(ref)) return MASK;
        const res = vars.resolve(whole);
        res.undefined.forEach((n) => undefinedNames.add(n));
        circular.push(...res.circular);
        return res.secret ? `${SECRET_OPEN}${res.value}${SECRET_CLOSE}` : res.value;
      })
      .join("");
  const encode = (text: string) =>
    segments(text)
      .map(({ text, ref }) => (ref !== undefined && isDynamic(ref) ? text : encodeURIComponent(resolve(text))))
      .join("")
      .replaceAll(encodeURIComponent(SECRET_OPEN), SECRET_OPEN)
      .replaceAll(encodeURIComponent(SECRET_CLOSE), SECRET_CLOSE);
  const a = r.auth;
  const headers: [string, string][] = [];
  const auth: [string, string][] = [];
  const params = r.query.enabled ? r.query.items.filter((p) => p.enabled && p.name).map((p) => `${encode(p.name)}=${encode(p.value)}`) : [];
  if (a.enabled && a.kind === "basic") {
    auth.push(["Username", resolve(a.username)], ["Password", resolve(a.password)]);
    // Like the core: credentials with a Secret are shown unencoded, so it can be masked.
    const creds = `${auth[0][1]}:${auth[1][1]}`;
    headers.push(["Authorization", `Basic ${creds.includes(SECRET_OPEN) ? `base64(${creds})` : btoa(creds)}`]);
  } else if (a.enabled && a.kind === "bearer") {
    auth.push(["Token", resolve(a.token.trim())]);
    headers.push(["Authorization", `Bearer ${auth[0][1]}`]);
  } else if (a.enabled && a.kind === "apiKey") {
    auth.push(["Key", a.keyName], ["Value", resolve(a.keyValue)]);
    if (a.keyLocation === "header") headers.push([a.keyName, auth[1][1]]);
    else params.push(`${encode(a.keyName)}=${encode(a.keyValue)}`);
  }
  if (r.headers.enabled) for (const h of r.headers.items.filter((h) => h.enabled && h.name)) headers.push([resolve(h.name), resolve(h.value)]);
  let url = resolve(r.url.trim()) + (params.length ? `?${params.join("&")}` : "");
  const plain = url.replaceAll(SECRET_OPEN, "").replaceAll(SECRET_CLOSE, "");
  if (!plain.includes("://") && !plain.startsWith("{{")) url = `http://${url}`;
  const has = (name: string) => headers.some(([n]) => n.toLowerCase() === name);
  const implied = { json: "application/json", xml: "application/xml", text: "text/plain", formUrlEncoded: "application/x-www-form-urlencoded" } as Record<string, string>;
  if (r.body.enabled && r.body.text.trim() && implied[r.body.mode] && !has("content-type")) headers.push(["Content-Type", implied[r.body.mode]]);
  if (!has("user-agent")) headers.push(["User-Agent", "HttpDesk/0.1.0"]);
  if (!has("accept-encoding")) headers.push(["Accept-Encoding", "gzip, deflate, br, zstd"]);
  if (r.body.enabled) resolve(r.body.text);
  const hostVars = [...url.split(/[/?#]/, url.includes("://") ? 3 : 1).join("/").matchAll(/\{\{\s*(.*?)\s*\}\}/g)].map((m) => m[1]);
  const error = hostVars.length
    ? { kind: "unresolvedVariable", message: `The URL's scheme or host uses undefined variables: ${hostVars.join(", ")}.`, details: { names: hostVars } }
    : null;
  const warnings = undefinedNames.size ? [`Undefined variables: ${[...undefinedNames].sort().join(", ")}`] : [];
  for (const chain of new Set(circular.map((c) => c.join(" → ")))) warnings.push(`Circular variable reference: ${chain}`);
  if (environment && !own.environments.some((e) => e.name === environment)) {
    const dir = filePath ? filePath.slice(ROOT.length + 1, filePath.lastIndexOf("/") + 1) : "";
    warnings.unshift(`Environment "${environment}" isn't defined for ${dir || "the workspace root"}, so it's sent with no environment`);
  }
  return { method: r.method.toUpperCase() || "GET", url, headers, auth, warnings, error };
}
/**
 * A rough stand-in for the core's `workspace::usages` (tested for real in Rust):
 * every `{{name}}` in the files (open documents as given), then in the env values.
 */
function findUsages(name: string, open: { path: string; file: any }[]) {
  const out: unknown[] = [];
  const refs = (text: string) =>
    [...text.matchAll(/\{\{(.*?)\}\}/g)].filter((m) => m[1].trim() === name).map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  for (const [path, disk] of Object.entries(files) as [string, any][]) {
    const f = open.find((o) => o.path === path)?.file ?? disk;
    f.header.variables.forEach((v: any, index: number) => refs(v.value).forEach((p) => out.push({ kind: "fileVariable", path, index, name: v.name, ...p })));
    f.requests.forEach((r: Request, index: number) => {
      const hit = { kind: "request", path, index, name: r.name.trim() || `${r.method} ${r.url}`, method: r.method, url: r.url };
      const fields: [unknown, string, boolean][] = [
        ...r.variables.map((v, i): [unknown, string, boolean] => [{ kind: "variable", index: i, name: v.name }, v.value, false]),
        [{ kind: "url" }, r.url, false],
      ];
      for (const [kind, s] of [["param", r.query], ["header", r.headers]] as const)
        s.items.forEach((kv, i) => {
          for (const part of ["name", "value"] as const) fields.push([{ kind, index: i, name: kv.name, part }, kv[part], !s.enabled || !kv.enabled]);
        });
      const a = r.auth;
      const apiKey: AuthPart[] = a.keyLocation === "query" ? ["keyName", "keyValue"] : ["keyValue"];
      const auth = ({ none: [], basic: ["username", "password"], bearer: ["token"], apiKey } as Record<string, AuthPart[]>)[a.kind];
      for (const part of auth) fields.push([{ kind: "auth", part }, a[part], !a.enabled]);
      if (r.body.mode !== "none") fields.push([{ kind: "body" }, r.body.text, !r.body.enabled]);
      for (const [field, text, off] of fields)
        for (const p of refs(text)) {
          const line = text.slice(text.lastIndexOf("\n", p.start - 1) + 1).trimStart();
          out.push({ ...hit, field, disabled: off || ((field as any).kind === "body" && line.startsWith("#~")), ...p });
        }
    });
  }
  for (const dir of ["", ...Object.keys(folderPairs).sort()]) {
    const pair = pairOf(dir)!;
    const envs: [string, MockEnvVar[]][] = [["$shared", pair.shared], ...pair.environments.map((e): [string, MockEnvVar[]] => [e.name, e.variables])];
    const folder = dir ? `${ROOT}/${dir}` : ROOT;
    for (const [env, vars] of envs)
      for (const v of vars)
        for (const p of refs(v.value))
          out.push({ kind: "environment", path: `${folder}/http-client${v.secret ? ".private" : ""}.env.json`, env, name: v.name, secret: v.secret, ...p });
  }
  return out;
}
type EnvMap = Record<string, Record<string, unknown>>;
/**
 * What saving writes to http-client.env.json (`shared`) and
 * http-client.private.env.json (`private`), like `env::save` in the Rust core:
 * a Secret's value goes only to the private file; a Secret already listed in
 * the shared file keeps an empty placeholder there.
 */
function splitEnvFiles(set: typeof envSet, old: { shared: EnvMap }): { shared: EnvMap; private: EnvMap } {
  const shared: EnvMap = {};
  const priv: EnvMap = {};
  const named: [string, MockEnvVar[]][] = [["$shared", set.shared], ...set.environments.map((e): [string, MockEnvVar[]] => [e.name, e.variables])];
  for (const [env, vars] of named) {
    const pub: Record<string, unknown> = {};
    const sec: Record<string, unknown> = {};
    for (const v of vars.filter((v) => v.name)) {
      if (v.secret) {
        sec[v.name] = v.value;
        if (old.shared[env] && v.name in old.shared[env]) pub[v.name] = "";
      } else pub[v.name] = v.value;
    }
    if (env !== "$shared" || Object.keys(pub).length || old.shared[env]) shared[env] = pub;
    if (Object.keys(sec).length) priv[env] = sec;
  }
  return { shared, private: priv };
}
let envFiles = splitEnvFiles(envSet, { shared: {} });
let settings = {
  exec: { timeoutMs: 30000, connectTimeoutMs: 10000, followRedirects: true, maxRedirects: 10, verifyTls: true, caCertPath: null, clientCertPath: null, clientKeyPath: null, maxBodyBytes: 104857600 },
  // `?recent=/work/shop,/work/api`: more recent workspaces after the demo one (File → Open Recent).
  recentWorkspaces: [ROOT, ...(new URLSearchParams(location.search).get("recent")?.split(",") ?? [])],
  environments: { [ROOT]: "local" },
  environmentSettings: {} as Record<string, Record<string, { production?: boolean; color?: string | null }>>,
  theme: new URLSearchParams(location.search).get("theme") ?? "system",
  layout: new URLSearchParams(location.search).get("layout") ?? "horizontal",
  checkUpdates: true,
  showDescriptions: true,
  sidebarWidth: 280,
  sidebarHidden: false,
  zoom: 1,
  splitRatio: { horizontal: 0.5, vertical: 0.5 },
  showResolved: false,
  // `?envView=matrix` opens the Environments modal on the matrix, as if the user had picked it.
  envView: new URLSearchParams(location.search).get("envView") === "matrix" ? "matrix" : "list",
  envMatrixWidths: {},
};
// Saved settings survive a reload of the page (like the real settings file), so
// a test can check something is still applied after `page.reload()`. Each test
// gets a fresh page, so it still starts from the defaults above.
const SAVED_SETTINGS = "httpdesk-mock-settings";
const saved = sessionStorage.getItem(SAVED_SETTINGS);
if (saved) settings = JSON.parse(saved);

/** Browser tests read this (see `sentRequests` in e2e/helpers.ts). */
const sent: unknown[] = [];
/** The `promptValues` each `send_request` got, in order. */
const sentPrompts: Record<string, string>[] = [];
/** What "Save body to file" wrote, by path. */
const savedBodies: Record<string, string> = {};
/** The response ids `response_shape` was asked for, in order (fetched once per response). */
const shapeRequests: string[] = [];
/** The response ids `release_response` was called with, in order. */
const releasedResponses: string[] = [];
let settingsServed = false;
/** The bodies the viewer fetched with `response_body`, in order. */
let bodyRequests: { id: string; view: string }[] = [];
let previewRequests = 0;
let windowTitle: string | null = null;
let windowCloseRequests = 0;
let windowClosed = false;
/** The webview zoom the app last set (the shell's starts at the saved one, as theme.rs applies it). */
let webviewZoom: number | null = null;
/** The `.http` files `save_http_file` wrote, in order. */
const savedPaths: string[] = [];
/** The URLs the opener opened, in order. */
const openedUrls: string[] = [];
/** The OS clipboard, as the clipboard plugin reads and writes it. */
let clipboardText = "";
/** The texts the clipboard plugin wrote, in order. */
const clipboardWrites: string[] = [];
/** Whether the clipboard plugin's writes fail (a test sets it). */
let clipboardFails = false;
/**
 * Like the shell's opener: only URLs its capability's scope allows (globs, `*`
 * matching anything), so a link the capability doesn't cover fails here too.
 */
const openableUrls = capabilities.permissions
  .flatMap((p) => (typeof p === "object" && p.identifier === "opener:allow-open-url" ? p.allow : []))
  .map(({ url }) => new RegExp(`^${url.split("*").map((s) => s.replace(/[.?+^$()[\]{}|\\]/g, "\\$&")).join(".*")}$`));
/** Runs `cancel_request` was called for that are still sending. */
const cancelledRuns = new Set<string>();

// ---- The native menu bar (src-tauri/src/menu.rs), as the app sent it.
type MenuEntry =
  | { kind: "item"; id: string; label: string; accelerator: string | null; enabled: boolean; checked: boolean | null }
  | { kind: "separator" }
  | { kind: "predefined"; item: string; label: string | null }
  | { kind: "submenu"; label: string; enabled: boolean; items: MenuEntry[] };
type MenuItemEntry = Extract<MenuEntry, { kind: "item" }>;
type MenuChange = { id: string; enabled?: boolean; checked?: boolean };
let menuBar: { label: string; items: MenuEntry[] }[] = [];
const menuStateChanges: MenuChange[][] = [];
/** Every item in the menu bar (the same id may be in several menus). */
const menuItems = (entries: MenuEntry[] = menuBar.flatMap((m) => m.items)): MenuItemEntry[] =>
  entries.flatMap((e) => (e.kind === "item" ? [e] : e.kind === "submenu" ? menuItems(e.items) : []));
/** Like the shell: only the menu bar's own items send a `menu` event. */
async function menuClick(id: string) {
  if (menuItems().some((i) => i.id === id)) await emit("menu", { id });
}
// On macOS a key the page left alone (no `preventDefault()`) reaches the menu, which
// runs the enabled item with that key equivalent (ADR-0005). The check waits for
// the page's own handlers, which run after this capture listener.
const ACCELERATOR_KEYS: Record<string, string> = { Enter: "Enter", ",": "," };
function acceleratorOf(e: KeyboardEvent): string {
  const key = ACCELERATOR_KEYS[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return [e.metaKey && "Cmd", e.altKey && "Alt", e.shiftKey && "Shift", e.ctrlKey && "Ctrl", key].filter(Boolean).join("+");
}
window.addEventListener(
  "keydown",
  (e) => {
    setTimeout(() => {
      if (e.defaultPrevented) return;
      const item = menuItems().find((i) => i.accelerator && i.enabled && i.accelerator === acceleratorOf(e));
      if (item) void menuClick(item.id);
    });
  },
  { capture: true },
);

(window as unknown as { __mock: unknown }).__mock = {
  sent,
  sentPrompts,
  get savedPaths() {
    return [...savedPaths];
  },
  /** The native menu bar as the app last sent it, with the state changes since applied. */
  get menu() {
    return { layout: clone(menuBar) };
  },
  /** Each batch of item state changes the app sent, in order. */
  get menuStateChanges() {
    return clone(menuStateChanges);
  },
  /** A click on the native menu item `id`: sends the `menu` event the shell would. */
  menuClick,
  /** The URLs the opener opened in the browser, in order. */
  get openedUrls() {
    return [...openedUrls];
  },
  /** The OS clipboard the clipboard plugin reads and writes; a test may set it. */
  get clipboard() {
    return clipboardText;
  },
  set clipboard(text: string) {
    clipboardText = text;
  },
  /** The texts the clipboard plugin wrote, in order. */
  get clipboardWrites() {
    return [...clipboardWrites];
  },
  /** Makes the clipboard plugin's writes fail, or succeed again. */
  set clipboardFails(fails: boolean) {
    clipboardFails = fails;
  },
  /** The window title the app last set. */
  get title() {
    return windowTitle;
  },
  /** How many times the app asked the window to close. */
  get windowCloseRequests() {
    return windowCloseRequests;
  },
  /** Whether a close request went through and the window was destroyed. */
  get windowClosed() {
    return windowClosed;
  },
  /** The webview zoom the app last set, null before it sets one. */
  get webviewZoom() {
    return webviewZoom;
  },
  /** The bodies the viewer fetched with `response_body` (response id and view), in order. */
  get bodyRequests() {
    return clone(bodyRequests);
  },
  /** Forgets the fetches so far. */
  resetBodyRequests: () => {
    bodyRequests = [];
  },
  /** How many times the resolved preview called `preview_request`. */
  get previewRequests() {
    return previewRequests;
  },
  /** Whether the app has been given its settings yet. */
  get settingsServed() {
    return settingsServed;
  },
  /** Lets held settings through (`?settingsDelay=hold`). */
  releaseSettings: () => releaseSettings(),
  /** Lets held Pretty text through (`?pretty=hold`). */
  releasePretty: () => releasePretty(),
  get settings() {
    return clone(settings);
  },
  /** The `.http` file models as last saved, by path (the mock has no serializer). */
  get files() {
    return clone(files);
  },
  get savedBodies() {
    return clone(savedBodies);
  },
  get shapeRequests() {
    return [...shapeRequests];
  },
  get releasedResponses() {
    return [...releasedResponses];
  },
  /** The `?response=` kind the next send uses. */
  set response(kind: string | null) {
    responseKind = kind;
  },
  /** The two env files as last written (see `splitEnvFiles`). */
  get envFiles() {
    return clone(envFiles);
  },
  /** Each folder's own pair of env files below the root, as last saved, by folder ("api"). */
  get folderPairs() {
    return clone(folderPairs);
  },
};

type Node = { name: string; path: string; kind: string; children?: Node[] };
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const findNode = (n: Node, path: string): Node | undefined =>
  n.path === path ? n : n.children?.map((c) => findNode(c, path)).find(Boolean);
function addNode(path: string, kind: "dir" | "file") {
  findNode(tree, parentOf(path))?.children?.push({ name: nameOf(path), path, kind, ...(kind === "dir" ? { children: [] } : {}) });
}
/** Re-points a node and everything below it, plus any file contents, to a new path. */
function moveNode(from: string, to: string) {
  const node = findNode(tree, from);
  const parent = findNode(tree, parentOf(from));
  if (!node || !parent) return;
  parent.children = parent.children!.filter((c) => c !== node);
  const remap = (n: Node) => {
    n.path = to + n.path.slice(from.length);
    n.children?.forEach(remap);
  };
  remap(node);
  node.name = nameOf(to);
  findNode(tree, parentOf(to))?.children?.push(node);
  for (const p of Object.keys(files).filter((p) => p === from || p.startsWith(from + "/"))) {
    files[to + p.slice(from.length)] = files[p];
    delete files[p];
  }
}

/** Drops a node, everything below it, and any file contents. */
function removeNode(path: string) {
  const parent = findNode(tree, parentOf(path));
  if (parent?.children) parent.children = parent.children.filter((c) => c.path !== path);
  for (const p of Object.keys(files).filter((p) => p === path || p.startsWith(path + "/"))) delete files[p];
}
// `?trash=unavailable` simulates a volume without a trash: `delete_path` refuses.
const trashUnavailable = new URLSearchParams(location.search).get("trash") === "unavailable";
// `?openapiConflicts=1`: OpenAPI generation reports that its target file already exists.
const openapiConflicts = new URLSearchParams(location.search).get("openapiConflicts") === "1";
// `?sendError=<kind>`: every send fails with that kind of classified error (see `SendError`),
// except that `unresolvedVariable` fails only while no environment is selected.
const sendErrorKind = new URLSearchParams(location.search).get("sendError");
/** A transport error's message as the core writes it: reqwest's error chain ending in `cause`. */
const connectErrorChain = (cause: string) => `error sending request for url (http://api.exmaple.com/pets): client error (Connect): ${cause}`;
/** The fixture for each kind: the rest of the `SendError` of that kind. */
type SendErrorFixtures = { [K in SendErrorKind]: Omit<SendError & { kind: K }, "kind"> };
const sendErrors: SendErrorFixtures = {
  dns: { message: connectErrorChain("dns error: failed to lookup address information"), details: { host: "api.exmaple.com" } },
  refused: { message: connectErrorChain("tcp connect error: Connection refused (os error 61)"), details: { host: "127.0.0.1", port: 8765 } },
  reset: { message: connectErrorChain("connection closed before message completed"), details: { host: "127.0.0.1", port: 8765 } },
  tls: { message: connectErrorChain("invalid peer certificate: UnknownIssuer"), details: { reason: "selfSigned" } },
  timeoutIdle: {
    message: "Read timeout: no data received for 200 ms. Raise it with # @timeout or the idle timeout in Settings.",
    details: { timeoutMs: 200 },
  },
  timeoutConnect: {
    message:
      "Connection timeout: couldn't connect within 10 s. Check the host is reachable, or raise it with # @connection-timeout or the connection timeout in Settings.",
    details: { timeoutMs: 10000 },
  },
  unresolvedVariable: {
    message:
      "The URL's scheme or host uses undefined variables: baseUrl. Pick an environment that defines them, or declare them as file variables.",
    details: { names: ["baseUrl"] },
  },
  circularVariable: {
    message: "The URL's scheme or host uses a circular variable reference: baseUrl → host → baseUrl.",
    details: { chains: [["baseUrl", "host", "baseUrl"]] },
  },
  invalidUrl: { message: 'Invalid URL "http://[x": invalid IPv6 address', details: { url: "http://[x", reason: "invalid IPv6 address" } },
  file: { message: "Could not read file /demo/api/missing.json: No such file or directory (os error 2)", details: { path: "/demo/api/missing.json", reason: "No such file or directory (os error 2)" } },
  other: { message: "Something unexpected went wrong", details: null },
};
const sendError: SendError | null =
  sendErrorKind && Object.hasOwn(sendErrors, sendErrorKind) ? ({ kind: sendErrorKind, ...sendErrors[sendErrorKind as SendErrorKind] } as SendError) : null;
// `?manyHeaders=1`: the JSON response also carries caching, CORS and rate-limit headers.
const manyHeaders = new URLSearchParams(location.search).get("manyHeaders") === "1";
const extraHeaders: [string, string][] = manyHeaders
  ? [["cache-control", "public, max-age=60"], ["etag", '"pets-v1"'], ["x-cache", "HIT"], ["access-control-allow-origin", "*"], ["ratelimit-remaining", "42"]]
  : [];
// `?response=gzip`: the JSON response arrives gzip-encoded (fewer bytes on the wire than decoded).
// `?response=bigint`: the JSON response carries an ID above 2^53 and a `10.50`.
// `?response=invalidJson`: a JSON content type with a body that doesn't parse.
// `?response=store`: items with a `status` and 19-digit IDs, and item 2 becomes
//   "sold" from the second send on (filter tests).
// `?response=html`: an HTML page; `?response=longHtml`: a 200-line one. `?response=text`: a plain-text body. `?response=truncated`: a JSON body cut off at the size limit.
// `?response=nested`: `{"a":{"odd key":[{"b":1}]}}` (Copy path tests).
/** The content type and body kind of the non-JSON text responses, by `?response=` kind; anything else is JSON. */
const TEXT_RESPONSE_TYPES: Record<string, { contentType: string; bodyKind: ResponseKind }> = {
  json: { contentType: "application/json", bodyKind: "json" },
  html: { contentType: "text/html; charset=utf-8", bodyKind: "html" },
  longHtml: { contentType: "text/html; charset=utf-8", bodyKind: "html" },
  text: { contentType: "text/plain; charset=utf-8", bodyKind: "text" },
};
// A test may switch it between sends with `__mock.response = "..."` (setMockResponse in e2e/helpers.ts).
let responseKind = new URLSearchParams(location.search).get("response");
// `?download=slow`: the send takes ~2 s, its body "arriving" as `send-progress`
// events (bytes so far) every 100 ms, like the shell emits for a slow download.
const slowDownload = new URLSearchParams(location.search).get("download") === "slow";
// `?response=cookies`: the JSON response comes after a redirect that set a cookie,
// and sets three more (one with Expires, one with Max-Age, one malformed).
const FINAL_URL = "http://127.0.0.1:8765/pets?limit=20";
const cookie = (c: Partial<ResponseCookie> & { raw: string }): ResponseCookie => ({
  name: "", value: "", domain: null, path: null, expires: null, maxAge: null, secure: false, httpOnly: false, sameSite: null, url: FINAL_URL, parseError: null, ...c,
});
const mockCookies = [
  cookie({ name: "session", value: "abc123", path: "/", secure: true, httpOnly: true, sameSite: "Lax", url: "http://127.0.0.1:8765/login", raw: "session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax" }),
  cookie({ name: "theme", value: "dark", domain: "example.com", expires: "2026-12-01T00:00:00Z", raw: "theme=dark; Domain=.example.com; Expires=Tue, 01 Dec 2026 00:00:00 GMT" }),
  cookie({ name: "visits", value: "3", maxAge: 3600, sameSite: "Strict", raw: "visits=3; Max-Age=3600; SameSite=Strict" }),
  cookie({ raw: "not a cookie", parseError: "the cookie is missing a name/value pair" }),
];
// `?status=422`: the JSON response comes back with this status code instead.
const statusParam = Number(new URLSearchParams(location.search).get("status")) || null;
const reasonPhrases: Record<number, string> = { 200: "OK", 201: "Created", 404: "Not Found", 422: "Unprocessable Content", 500: "Internal Server Error" };
// `?bigBinary=1`: the image response is a 2 MB binary body instead of a small PNG.
const bigBinary = new URLSearchParams(location.search).get("bigBinary") === "1";
const BIG_BINARY_BYTES = 2 * 1024 * 1024;
// `?largeBody=1`: the JSON response's Pretty text takes a while to format.
const largeBody = new URLSearchParams(location.search).get("largeBody") === "1";
// `?evicted=1`: `response_body` finds no stored body, as after eviction.
const evicted = new URLSearchParams(location.search).get("evicted") === "1";
// `?timing=reused`: the JSON response's final request went over an open
// connection after two redirects, so it has no DNS or connect phase.
const timingParam = new URLSearchParams(location.search).get("timing");
const jsonTimings =
  timingParam === "reused"
    ? { ttfb: 24.6, download: 6.9, reused: true, redirects: 2 }
    : { dns: 1.4, connect: 3.6, ttfb: 25.2, download: 7.0, reused: false, redirects: 0 };
/** The image responses open a connection without a lookup, so they have no DNS phase. */
const imageTimings = { connect: 0.8, ttfb: 9.1, download: 2.2, reused: false, redirects: 0 };
// `?settingsDelay=<ms>`: settings arrive late, as on a slow start.
// `?settingsDelay=hold`: settings wait until a test calls `__mock.releaseSettings()`.
const settingsDelayParam = new URLSearchParams(location.search).get("settingsDelay");
const settingsHeld = settingsDelayParam === "hold";
const settingsDelay = settingsHeld ? 0 : Number(settingsDelayParam ?? 0);
let releaseSettings: () => void = () => {};
const settingsReleased = settingsHeld ? new Promise<void>((r) => (releaseSettings = r)) : Promise.resolve();
// `?pretty=hold`: `response_body`'s Pretty text waits until a test calls `__mock.releasePretty()`,
// so the viewer's loading state lasts as long as the test needs.
const prettyHeld = new URLSearchParams(location.search).get("pretty") === "hold";
let releasePretty: () => void = () => {};
const prettyReleased = prettyHeld ? new Promise<void>((r) => (releasePretty = r)) : Promise.resolve();

/**
 * A small part of RFC 9535 JSONPath for the mocked `filter_response`: `$`,
 * `.name`, `.*`, `..name`, `[n]`, `[*]`, `['name']`, and `[?(@.a.b OP literal)]`
 * or `[?@.a]`. Numbers are kept as the server wrote them (`JSON.rawJSON`), so
 * the output matches the core's.
 */
function mockFilter(body: string, expression: string): { matches: number; text: string } {
  const J = JSON as any;
  const doc = J.parse(body, (_k: string, v: unknown, ctx: { source?: string }) => (typeof v === "number" ? J.rawJSON(ctx.source) : v));
  const isNode = (v: unknown): v is object => v !== null && typeof v === "object" && !J.isRawJSON(v);
  const scalar = (v: any) => (J.isRawJSON(v) ? Number(v.rawJSON) : v);
  const children = (v: unknown): unknown[] => (isNode(v) ? Object.values(v) : []);
  const descendants = (v: unknown): unknown[] => [v, ...children(v).flatMap(descendants)];
  const expr = expression.trim();
  let i = 0;
  const fail = (what: string): never => {
    throw `Invalid JSONPath at position ${i + 1}: ${what}`;
  };
  const name = () => /^[A-Za-z_][\w]*/.exec(expr.slice(i))?.[0] ?? fail("expected a member name");
  const relPath = (): string[] => {
    const keys: string[] = [];
    while (expr[i] === ".") {
      i++;
      const k = name();
      keys.push(k);
      i += k.length;
    }
    return keys;
  };
  const literal = (): unknown => {
    const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(expr.slice(i)) ?? fail("expected a literal");
    i += m[0].length;
    return m[1].startsWith("'") ? m[1].slice(1, -1) : JSON.parse(m[1]);
  };
  if (expr[i] !== "$") fail("expected '$'");
  i++;
  let nodes: unknown[] = [doc];
  while (i < expr.length) {
    if (expr.startsWith("..", i)) {
      i += 2;
      const k = name();
      i += k.length;
      nodes = nodes.flatMap(descendants).flatMap((n) => (isNode(n) && !Array.isArray(n) && k in n ? [(n as any)[k]] : []));
    } else if (expr.startsWith(".*", i) || expr.startsWith("[*]", i)) {
      i += expr[i] === "." ? 2 : 3;
      nodes = nodes.flatMap(children);
    } else if (expr[i] === ".") {
      i++;
      const k = name();
      i += k.length;
      nodes = nodes.flatMap((n) => (isNode(n) && !Array.isArray(n) && k in n ? [(n as any)[k]] : []));
    } else if (expr.startsWith("[?", i)) {
      i += 2;
      const paren = expr[i] === "(";
      if (paren) i++;
      if (expr[i] !== "@") fail("expected '@'");
      i++;
      const keys = relPath();
      const op = /^\s*(==|!=|<=|>=|<|>)/.exec(expr.slice(i));
      let test: (v: unknown) => boolean = (v) => v !== undefined;
      if (op) {
        i += op[0].length;
        const lit = literal();
        const cmp: Record<string, (a: any, b: any) => boolean> = {
          "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, ">=": (a, b) => a >= b,
        };
        test = (v) => v !== undefined && cmp[op[1]](scalar(v), lit);
      }
      if (paren && expr[i++] !== ")") fail("expected ')'");
      if (expr[i++] !== "]") fail("expected ']'");
      const at = (n: unknown) => keys.reduce<any>((v, k) => (isNode(v) && k in v ? (v as any)[k] : undefined), n);
      nodes = nodes.flatMap(children).filter((n) => test(at(n)));
    } else if (expr[i] === "[") {
      const m = /^\[\s*(?:(-?\d+)|'([^']*)'|"([^"]*)")\s*\]/.exec(expr.slice(i)) ?? fail("expected a selector");
      i += m[0].length;
      nodes = nodes.flatMap((n) => {
        if (m[1] !== undefined) return Array.isArray(n) && n.at(Number(m[1])) !== undefined ? [n.at(Number(m[1]))] : [];
        const k = m[2] ?? m[3];
        return isNode(n) && !Array.isArray(n) && k in n ? [(n as any)[k]] : [];
      });
    } else fail("unexpected character");
  }
  return { matches: nodes.length, text: formatJson(JSON.stringify(nodes), "pretty") };
}

/** Stand-in for the core's `json_filter::Shape`: keys in first-seen order, array items merged. */
function mockShape(values: unknown, into: JsonShape = {}): JsonShape {
  if (Array.isArray(values)) {
    into.items ??= {};
    for (const v of values) mockShape(v, into.items);
  } else if (values !== null && typeof values === "object") {
    into.keys ??= [];
    for (const [k, v] of Object.entries(values)) {
      let entry = into.keys.find(([name]) => name === k);
      if (!entry) into.keys.push((entry = [k, {}]));
      mockShape(v, entry[1]);
    }
  }
  return into;
}

/**
 * Stand-in for the core's lossless `format_body` (JSON only): JSON.parse only
 * checks validity, and the output is the input's own tokens re-indented, so
 * numbers stay as written, like the real formatter.
 */
function formatJson(text: string, mode: "pretty" | "minify"): string {
  JSON.parse(text); // throws for invalid JSON
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g) ?? [];
  const nl = (depth: number) => (mode === "pretty" ? "\n" + "  ".repeat(depth) : "");
  let out = "";
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "{" || t === "[") && (tokens[i + 1] === "}" || tokens[i + 1] === "]")) {
      out += t + tokens[++i];
    } else if (t === "{" || t === "[") out += t + nl(++depth);
    else if (t === "}" || t === "]") out += nl(--depth) + t;
    else if (t === ",") out += t + nl(depth);
    else if (t === ":") out += mode === "pretty" ? ": " : ":";
    else out += t;
  }
  return out;
}

/**
 * Stand-in for the core's XML `format_body`, good enough for simple documents:
 * one element per line, `<a>text</a>` kept on its line. Throws for XML the
 * browser can't parse.
 */
function formatXml(text: string, mode: "pretty" | "minify"): string {
  if (new DOMParser().parseFromString(text, "application/xml").querySelector("parsererror")) throw "Invalid XML";
  const tokens = (text.match(/<[^>]+>|[^<]+/g) ?? []).filter((t) => t.trim());
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("</")) depth--;
    if (/^<[^/?!][^>]*[^/]>$/.test(t) && !tokens[i + 1]?.startsWith("<") && tokens[i + 2]?.startsWith("</")) {
      lines.push("  ".repeat(depth) + t + tokens[i + 1] + tokens[i + 2]);
      i += 2;
      continue;
    }
    lines.push("  ".repeat(depth) + t);
    if (/^<[^/?!].*[^/]>$/.test(t)) depth++;
  }
  return mode === "pretty" ? lines.join("\n") : lines.map((l) => l.trim()).join("");
}

/** Text response bodies by response id, with their kind, like the shell's stored bodies. */
const textBodies = new Map<string, { body: string; kind: ResponseKind }>();
let responseCount = 0;

/** Stand-in for the shell's Pretty text: formatted JSON or XML; rejects like the shell otherwise. */
function prettyText({ body, kind }: { body: string; kind: ResponseKind }): string {
  if (kind === "xml") return formatXml(body, "pretty");
  if (kind !== "json") throw "Response body isn't JSON or XML";
  try {
    return formatJson(body, "pretty");
  } catch (e) {
    throw `Invalid JSON: ${e instanceof Error ? e.message : e}`;
  }
}

/** Binary response bodies by response id, like the shell's stored bodies. */
const binaryBodies = new Map<string, string>();
function storeBinary<T extends { id: string; bodyBase64: string }>(response: T): T {
  binaryBodies.set(response.id, response.bodyBase64);
  return response;
}

/** Stand-in for the core's `hexdump`: the first 64 KB of a stored body. */
function hexdump(b64: string): string {
  const limit = 64 * 1024;
  const bytes = atob(b64.slice(0, Math.ceil(limit / 3) * 4)).slice(0, limit);
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = [...bytes.slice(off, off + 16)].map((c) => c.charCodeAt(0));
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (base64DecodedLength(b64) > limit) lines.push("… (truncated preview)");
  return lines.join("\n");
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

mockWindows("main");
mockIPC(
  async (cmd, args: any) => {
    switch (cmd) {
      case "plugin:clipboard-manager|read_text":
        return clipboardText;
      case "plugin:clipboard-manager|write_text":
        if (clipboardFails) throw "The clipboard can't be written";
        clipboardText = args.text;
        clipboardWrites.push(args.text);
        return null;
      case "plugin:opener|open_url":
        if (!openableUrls.some((re) => re.test(args.url))) throw `Not allowed to open url ${args.url}`;
        openedUrls.push(args.url);
        return null;
      case "app_info": {
        const os = currentOS();
        return { version: "0.9.8", os: os === "mac" ? "macos" : os, arch: os === "mac" ? "aarch64" : "x86_64" };
      }
      case "plugin:window|set_title":
        windowTitle = args.value;
        return null;
      case "plugin:window|close":
        // Like the shell: a close request the app answers in its close-requested
        // handler, which destroys the window unless it was turned down.
        windowCloseRequests++;
        await emit("tauri://close-requested");
        return null;
      case "plugin:window|destroy":
        windowClosed = true;
        return null;
      case "plugin:webview|set_webview_zoom":
        webviewZoom = args.value;
        return null;
      case "get_settings":
        if (settingsDelay) await delay(settingsDelay);
        await settingsReleased;
        settingsServed = true;
        return clone(settings);
      case "save_settings":
        settings = args.settings;
        sessionStorage.setItem(SAVED_SETTINGS, JSON.stringify(settings));
        return null;
      case "path_exists":
        return true;
      case "open_workspace":
        // Like the shell, the opened folder goes to the top of the recent workspaces
        // (the mock always opens the demo workspace, though).
        settings.recentWorkspaces = [args.path, ...settings.recentWorkspaces.filter((p: string) => p !== args.path)];
        return { root: ROOT, tree, gitignoreUpdated: false };
      case "set_menu":
        menuBar = clone(args.layout);
        return null;
      case "set_menu_state":
        menuStateChanges.push(clone(args.changes));
        for (const change of args.changes as MenuChange[]) {
          for (const item of menuItems().filter((i) => i.id === change.id)) {
            if (change.enabled !== undefined) item.enabled = change.enabled;
            if (change.checked !== undefined && item.checked !== null) item.checked = change.checked;
          }
        }
        return null;
      case "get_tree":
        return tree;
      case "load_environments":
        if (args?.dir && !findNode(tree, `${ROOT}/${args.dir}`)) throw `${args.dir} is not a folder of the workspace`;
        return clone(loadFor([args?.dir ?? ""], () => ""));
      case "load_folder_environments":
        return clone(folderEnvironments());
      case "save_environments": {
        // Sources are what loading reports; saving ignores them.
        const set = clone(args.set) as MockSet & { sharedSource?: unknown; environments: { source?: unknown }[] };
        delete set.sharedSource;
        for (const e of set.environments) delete e.source;
        if (args.dir) {
          if (!findNode(tree, `${ROOT}/${args.dir}`)) throw `${args.dir} is not a folder of the workspace`;
          folderPairs[args.dir] = set;
          return { gitignoreUpdated: false };
        }
        envSet = set;
        envFiles = splitEnvFiles(envSet, envFiles);
        return { gitignoreUpdated: false };
      }
      case "read_http_file":
        return clone(files[args.path]);
      case "save_http_file":
        savedPaths.push(args.path);
        files[args.path] = clone(args.file);
        return clone(args.file);
      case "create_file": {
        // Parsing `args.content` needs the Rust core; one request from the fixture stands in.
        const req = { ...clone((pets as any).requests[0]), name: "New request", raw: null, leading: "" };
        files[args.path] = { ...clone(pets as any), requests: [req], trailing: "" };
        addNode(args.path, "file");
        return null;
      }
      case "create_dir":
        addNode(args.path, "dir");
        return null;
      case "rename_path":
        moveNode(args.from, args.to);
        return null;
      case "delete_path":
        if (trashUnavailable) return "trashUnavailable";
        removeNode(args.path);
        return "trashed";
      case "delete_permanently":
        removeNode(args.path);
        return null;
      case "preview_request":
        previewRequests++;
        return previewRequest(args as unknown as PreviewArgs);
      case "render_request": {
        const r = args.request;
        const vars = r.variables.filter((v: any) => v.name).map((v: any) => `@${v.name} = ${v.value}\n`).join("");
        return `### ${r.name}\n${vars}${r.method} ${r.url}\n${r.headers.items.map((h: any) => `${h.enabled ? "" : "#~ "}${h.name}: ${h.value}`).join("\n")}\n`;
      }
      case "search_requests": {
        // Same matching as the backend: every term in name, method, URL or file name.
        const terms = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
        return Object.entries(files).flatMap(([path, f]: [string, any]) =>
          f.requests.flatMap((r: any, index: number) => {
            const name = r.name.trim() || `${r.method} ${r.url}`;
            const hay = `${name} ${r.method} ${r.url} ${path.split("/").pop()}`.toLowerCase();
            return terms.every((t) => hay.includes(t)) ? [{ path, index, name, method: r.method, url: r.url }] : [];
          }),
        );
      }
      case "find_usages":
        return findUsages(String(args.name), args.open ?? []);
      case "cancel_request":
        cancelledRuns.add(args.runId);
        return null;
      case "send_request": {
        sent.push(clone(args.request));
        sentPrompts.push(clone(args.promptValues ?? {}));
        if (slowDownload) {
          for (let i = 1; i <= 20; i++) {
            await delay(100);
            // Like the shell: a cancelled send fails (the app shows it as Cancelled).
            if (cancelledRuns.delete(args.runId)) throw "cancelled";
            await emit("send-progress", { runId: args.runId, received: i * 6_000 });
          }
        } else {
          await delay(450);
        }
        // An environment defines the missing variable, so picking one fixes it.
        if (sendError && !(sendError.kind === "unresolvedVariable" && args.environment)) throw clone(sendError);
        const r = args.request;
        if (r.url.includes("png") && bigBinary) {
          return storeBinary({
            id: `r3-${++responseCount}`, status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "http://127.0.0.1:8765/png/1",
            headers: [["content-type", "application/octet-stream"], ["content-length", String(BIG_BINARY_BYTES)]], timeMs: 52.3, ttfbMs: 10.1,
            bodySize: BIG_BINARY_BYTES, transferredSize: BIG_BINARY_BYTES, headersSize: 60, contentType: "application/octet-stream", bodyKind: "binary", contentEncoding: null, bodyText: null,
            bodyBase64: "AAAA".repeat(Math.floor(BIG_BINARY_BYTES / 3)) + "AAA=", // 2 MB of zero bytes (2 MB = 3n + 2)
            truncated: false, request: { method: "GET", url: "http://127.0.0.1:8765/png/1", headers: [], bodyPreview: null, bodySize: 0 }, warnings: [], timings: imageTimings, cookies: [],
          });
        }
        if (r.url.includes("png")) {
          return storeBinary({
            id: `r2-${++responseCount}`, status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "http://127.0.0.1:8765/png/1",
            headers: [["content-type", "image/png"], ["content-length", "2749"]], timeMs: 12.3, ttfbMs: 10.1, bodySize: 2749, transferredSize: 2749, headersSize: 60,
            contentType: "image/png", bodyKind: "image", contentEncoding: null, bodyText: null,
            bodyBase64: "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAKhElEQVR42u2df4xUVxXHz31vfi3dYamtkdUiQwRqTYzD+of8ENlGGym2ZjHaYNQy1BCFsu5im7BAjJiUbaqmDKwm+GPtQP8g1ppuLRSjiR0Euk1M2SFqKj+SDsXE/lFTYJf9MTPvXc97u+v+gM3Ove++XzvnhMDsy8vusJ/vu/ee7z33jAYUNR0a/QpIABQkAAoSAAUJgIIEQEECoKiliHj1g3jH+pRhltcxYGnOeRovpfBqCvjtboZJl6d8MXGVz3ZBzT18hvc35R3Ocs+02293T5EzVsRvVMDXBV2Lnqo7nC96wYW5Dd00K5vxVcYGXgXYGoQ/0z0oAJbV9cjLborBFQHwPQ+kTcNsw/9URgQswZ9+z+gLk7FcVI/+yA0hKBUA39eywBzqPzAFPMF3BH/yPRxYLpmM7mTZ/LXACaDS8UCGmeYBfLmA4KuHP3GVIXxty/zu0z2BEYCx6/PP3fLUE3zl8Kfdk03+pnenrwKwhnxjqP8lxqGZ4HsHn0+8yCcb4hudTAnM2Xw/8BqMpnQE33v441NCYX5D7H5ZEUgbQdaTT/D9hT/6BPN0//WRlzx1Aq05n4Z9/+FPuqe5P7M668kUMLbaf47gBwb+/+9Bl3Xj/Fxvj2sCsOf9wf63KdULHvzR98yuNbD4Eparfj0gNAUg/CzBDyZ86x9cDyy4AcNZV0YA296tmH0EP5jwJ0eMwZK63BtFpSMAwm8n+MGHb0XJhH1KR4DRXb3y2wQ/+PDHf9VcgyV3VjEKVDUC4JZuhuCHB/7Ys92icArgmwl+mOBjSmjidrwKAVjDP1AxR6jgj84BkHo/szLlWAAGGM0EP2TwJ+A1g9OaQGaYaYIfQvg2vNvs1YiOACYWcRL8EMK34bG08xEA+GKCH0L43B4BFisoC6fS7TDCH3sfKecCIPjhhD/jN3F6MITghwc+V30yiODPKfhiAiD4cw5+9QLwAn5dPegbd4C2NA3sroXA//sumJcLUPl9F8DQAMF3AX7Vi0C34bOPLIXIjiywefUT11AE+l3rQfvkGih3tQP/92WCrxh+dXsBHjz50+FP8SHmJSHaikUuKBKCL+EFKNoNdG3O1z6zfkb4U0TwzQ5bLARf5h5HAnB3wcc+lq5uqLpnGcTasqMiIPhK4FcnAJdX+7M9/dNFYI8EBF+ZESR8MER1qmfi4k4k9E+thei3dhN8RYtCzU/4tgD+fkZ45aqvfBC0+79G8BVkBJqf8O2vL/ZBJf+isAhiX221hUDwnaWDmp/wxy8YaPaYlwriInh0NzBcFxB8eS9A8xv+eJR+uVd4PWBFvB09hHuWEny3jCDPvH20e0sHsa/UJNu3mrA8gvjOg8Dn1RP82VE4EIAXGzsORJBoPwQwPaUk+IoE4OGuHr96Gcq/2Cs+lC1aBvHvdhJ8AfhVGkHeb+mal/qg/PzT4unh8hUQ27yb4LvZIcSr/fxK70kovdglLILIqg0QfXgLwa9SDVoQ4Y/fY/zld1B544/CIog+9BjoKASCHzAjSGY/v3y0E4zz4m5hPLMHtHtXEPygGEFOijlKR/dLeQSJbZ324pDg+2wEOa7kGRyA4QOtYGKZmHB6+MQhYB9oJPh+GUHKyrhuDsDI4T1yRtH2TtsjqDX4vhtBqmv4+NVLMPzs98TTw48uw5Ggi+B7aQS5VcBpiWAk1yklgviWvQTfCyPI7epdo/dVKRFE12yA2KY2gu+mEeRV6XYFRVB+/aSwCGJfeAQiqzfUBnyvjSCv6/ZLuf1SIohvwnXE3QtrHr5SI8ivQxulFw6BcfWycGZgTQe1Dl+ZEeTriZ3Bfhj+aauwCPR7m2oePlRzNCw0BzUlTJBahy9xPDyA8MfcPivNEwnjX+fmPHyutD9AQJ/82COtwvA5Wsvls6/WPHyB4+EBhY87fvZiTjCGj2EN4Xv/qXn4VR4PDyb8yOoHpeCX/vwCVM6eIPgya4Agwb/F1q0irGF/5Fi2duBzhU2iggJfW7RUCr7xDm4kdT9F8GUEECT4iSe7pOAP/ngHwVfiA/iV5+N+fnz707aLJ7rit+Hf7Cf4qvoE+gHf2s/X7m6UgP94zcLnbvQJ9KM5g1XgKZrrWzH0sw4wr1wi+Kr6BPoBP5bZC5EVnxOH370fjLfOEXxVfQL9gB/98relcv2Rl7uhcuYEwVfVJ9AP+DoWbcQefkwq1y/1dBN8dSOA9/A13KpNSOT6lQt9MPzrpwi+QJ9AZUaQKvgMD3IktndK5fpDhzoI/gwjNygtCHGrJw/m+HVo9Ijm+uZ778LgMzvs4hCCXz18JUaQUvhPdEkZPUNduxzBZ+gvRD7eNM1n4CJ9M2cZeiedei5ehApmJ+ZAv+/wHRtBKnvy1OGwL5PrDz7zOJg4/MvCT3yjHeJf3ARehonG1ODRZ2Ekf9z70ntVRpBK+HHM9W9bo1dFru8Eft3WH0Bs7ZfA69DuSEL9th+OpqyvveIbfMGjYe7A15c3SRd1WLm+LHz9viZf4E+OeY9+H9gdSd/gCxwNc68Pn75irXiufwYPhfzpt44WfNGmdeB3WCNB9BOf9g2+QLNo95ow6ouWCcO39vWdrvZl1htuhJ5a7ht8ISPIrSaM1ipeqKjDqudTkeoNDgRCANb7cLf0XoUP4GIHTuPCueqLOjDX54M3lOT5lbfOBUIApX+86XoNpvOPjHGxA2f57EnbyJntKbGHfUXw7V/86eO+jwLlf74JRvGCb/ClPzBCaR8+NHCGfr5rRhh2UQfm+sY7F5U6fBxz8YH923wTgWUI3fjJk+5XX8Nsnw09S9z8zme5J+1X6/CEz9fbbD9Aw5O71qhQ6fsrjODOnsonf/o92gcbIfGVrRC5r0m44kgWfOlveRg6ccwWodul9wv/UGDqBEAdOEP3oZizCSCi3ggi+IHsrKKqIojgzx34whVBBH9uwVdoBBH84H4QtnMj6ArBDyd8/HPFsQBMYEWCH8Yn3/6r6FgAjEOB4IcSPnAGBQVTACsQ/BDCn+nhFRWArut5gh8++KPVNpB3bAVbMbB1jbUOWEzwQwQf2JXG44WUorJwliP4YYKP+BlkQVVJWCQSyRH88MC3X+rQo0wAdYfzRUwHjxD8kDTRZOxIY0+hqLQqWGM8S/BD0kFVh32gul18/a9eL3BrFCD4wYYv8PQLt4tPJqPt+POuE/zAwr+e0KEd3PrACJbNX8PxJUPwg9lEE2Fm7uwpXHP1E0Pmd5/uQffgIMEPFnycng9+6JVCjyhPBpJxY8sqy2VaR/AD0EoP2Ck0fZplOGqyAkg2xFvwB58n+D4/+ZydT0SgRZajtACs9UCyIWap7hTB9+/Jr4tCs+i8r2QKmBz9mdVZE8w2gu/tnP/h44V2p+yUCMBeE2RWtZjAc7gF2UDw3U31rNW+zIJP6RRwS3aQ6+1pgEQKJXWE4Ltn8mCen1IFX+kIMDmGMitTJRP24fvfTPDVePuWvSvi8PkqgPF4H4WAP6IFDN7OgC8m+GL7+daWrrWr5wZ4TwRwixgMaMY6pTSYLI2XUByWKAj+WPVu0arhs8u4sJLHTei+CIAimKHRr4AEQEECoCABUJAAKEgAFCQAilqK/wEWJINOQzlGbAAAAABJRU5ErkJggg==",
            truncated: false, request: { method: "GET", url: "http://127.0.0.1:8765/png/1", headers: [], bodyPreview: null, bodySize: 0 }, warnings: [], timings: imageTimings, cookies: [],
          });
        }
        const body =
          responseKind === "bigint"
            ? `{"items":[{"id":9007199254740993,"price":10.50,"name":"Rex"}],"method":"${r.method}"}`
            : responseKind === "invalidJson"
              ? `{"id": 9007199254740993, oops}`
              : responseKind === "store"
                ? `{"items":[{"id":1234567890123456789,"status":"sold","price":10.50},{"id":2,"status":"${sent.length > 1 ? "sold" : "available"}","price":1e3},{"id":9007199254740993,"status":"sold"}]}`
                : responseKind === "html"
                  ? "<!doctype html><html><body><h1>Pets</h1></body></html>"
                  : responseKind === "longHtml"
                    ? `<!doctype html>\n<html><body>\n${Array.from({ length: 200 }, (_, i) => `<div class="row" data-index="${i}"><span class="label">Pet number ${i}</span> <a href="/pets/${i}" title="Open pet ${i}">open</a> <em class="tag">${"good dog ".repeat(20)}</em></div>`).join("\n")}\n</body></html>`
                  : responseKind === "text"
                    ? "pets: 2\nRex, Tom\n"
                  : responseKind === "truncated"
                    ? `{"items":[{"id":1,"name":"Rex"},{"id":2,"na`
                    : responseKind === "nested"
                      ? `{"a":{"odd key":[{"b":1}]}}`
                      : JSON.stringify({ items: [{ id: 1, name: "Rex", tags: ["good", "dog"], active: true }, { id: 2, name: "Tom", tags: [], active: false, owner: null }], method: r.method });
        const gzip = responseKind === "gzip";
        const transferredSize = gzip ? 112 : body.length;
        const status = statusParam ?? (r.method === "POST" ? 201 : 200);
        const id = `r1-${++responseCount}`; // a fresh id per response, like the shell's
        const { contentType, bodyKind } = TEXT_RESPONSE_TYPES[responseKind ?? ""] ?? TEXT_RESPONSE_TYPES.json;
        textBodies.set(id, { body, kind: bodyKind });
        const cookies = responseKind === "cookies" ? mockCookies : [];
        const setCookies = cookies.filter((c) => c.url === FINAL_URL).map((c) => ["set-cookie", c.raw]);
        return {
          id, status, statusText: reasonPhrases[status] ?? "", httpVersion: "HTTP/1.1",
          url: "http://127.0.0.1:8765/pets?limit=20",
          headers: [["content-type", contentType], ...(gzip ? [["content-encoding", "gzip"]] : []), ["content-length", String(transferredSize)], ["x-powered-by", "echo"], ["date", "Wed, 04 Nov 2026 07:00:00 GMT"], ...extraHeaders, ...setCookies],
          timeMs: 38.4, ttfbMs: 31.2, bodySize: body.length, transferredSize, headersSize: 120, contentType, bodyKind, contentEncoding: gzip ? "gzip" : null,
          bodyText: body, prettyText: null, bodyBase64: null, truncated: responseKind === "truncated",
          request: {
            method: r.method, url: "http://127.0.0.1:8765/pets?limit=20",
            headers: [["Authorization", "Bearer dev-token-123"], ["Accept", "application/json"], ["User-Agent", "HttpDesk/0.1.0"], ["Accept-Encoding", "gzip, deflate, br, zstd"]], bodyPreview: null, bodySize: 0,
          },
          warnings: [],
          timings: jsonTimings,
          cookies,
        };
      }
      case "format_body":
        if (args.kind === "xml") return formatXml(args.text, args.mode);
        try {
          return formatJson(args.text, args.mode);
        } catch (e) {
          throw `Invalid JSON: ${e instanceof Error ? e.message : e}`;
        }
      case "response_body": {
        // Like the shell: raw bytes (an ArrayBuffer), text as UTF-8.
        const { responseId: id, view } = args as { responseId: string; view: "raw" | "pretty" | "bytes" };
        bodyRequests.push({ id, view });
        if (view === "pretty") {
          if (largeBody) await delay(400); // as a large body takes a while to format
          await prettyReleased;
        }
        if (evicted) throw RESPONSE_GONE;
        const b64 = binaryBodies.get(id);
        if (b64 !== undefined) {
          if (view !== "bytes") throw "Response body isn't text";
          return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
        }
        const stored = textBodies.get(id);
        if (stored === undefined) throw RESPONSE_GONE;
        return new TextEncoder().encode(view === "pretty" ? prettyText(stored) : stored.body).buffer;
      }
      case "release_response":
        releasedResponses.push(args.responseId);
        textBodies.delete(args.responseId);
        binaryBodies.delete(args.responseId);
        return null;
      case "hexdump": {
        const b64 = binaryBodies.get(args.responseId);
        if (b64 === undefined) throw RESPONSE_GONE;
        return hexdump(b64);
      }
      case "filter_response": {
        const body = textBodies.get(args.responseId)?.body;
        if (body === undefined) throw RESPONSE_GONE;
        try {
          JSON.parse(body);
        } catch (e) {
          throw `The body isn't valid JSON: ${e instanceof Error ? e.message : e}`;
        }
        return mockFilter(body, args.expression);
      }
      case "response_shape": {
        shapeRequests.push(args.responseId);
        const body = textBodies.get(args.responseId)?.body;
        if (body === undefined) throw RESPONSE_GONE;
        return mockShape(JSON.parse(body));
      }
      case "plugin:dialog|save":
        return `${ROOT}/${args.options?.defaultPath ?? "response"}`;
      case "save_response_body": {
        // Binary bodies are recorded as their base64.
        const body = textBodies.get(args.responseId)?.body ?? binaryBodies.get(args.responseId);
        if (body === undefined) throw RESPONSE_GONE;
        savedBodies[args.path] = body;
        return null;
      }
      case "openapi_load":
        await delay(300);
        return {
          title: "Swagger Petstore", version: "1.0.0", openapiVersion: "3.0.3", description: null,
          servers: [{ url: "https://petstore.example.com/v1", description: "Production" }],
          tags: ["pet", "store"],
          operations: [
            { id: "listPets", method: "GET", path: "/pets", summary: "List all pets", operationId: "listPets", tags: ["pet"], deprecated: false },
            { id: "createPet", method: "POST", path: "/pets", summary: "Create a pet", operationId: "createPet", tags: ["pet"], deprecated: false },
            { id: "showPetById", method: "GET", path: "/pets/{petId}", summary: "Info for a specific pet", operationId: "showPetById", tags: ["pet"], deprecated: false },
            { id: "deletePet", method: "DELETE", path: "/pets/{petId}", summary: "Delete a pet", operationId: "deletePet", tags: ["pet"], deprecated: true },
            { id: "getInventory", method: "GET", path: "/store/inventory", summary: "Returns pet inventories", operationId: "getInventory", tags: ["store"], deprecated: false },
          ],
          warnings: ["Unresolved external $ref: https://example.com/common.yaml#/Error"],
        };
      case "openapi_generate": {
        const files = [`${ROOT}/swagger-petstore/pet.http`];
        const conflicts = openapiConflicts ? files : [];
        const written = !args.dryRun && (args.overwrite || !conflicts.length);
        return { files, conflicts, written, environments: ["production"], envDir: ROOT, gitignoreUpdated: false, warnings: [] };
      }
      default:
        return null; // plugins (dialog, window title, opener), cancel, etc.
    }
  },
  { shouldMockEvents: true },
);
