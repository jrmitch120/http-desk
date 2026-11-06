// Dev-only: lets the UI run in a plain browser (`pnpm dev`, open localhost:1420)
// for visual testing. Fixtures are produced by the real Rust parser
// (`cargo run -p httpdesk-core --example dump -- file.http`). Never bundled in
// production builds (imported behind `import.meta.env.DEV`).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import pets from "./pets.json";
import jetbrains from "./jetbrains.json";

const ROOT = "/demo";
const files: Record<string, unknown> = {
  [`${ROOT}/api/pets.http`]: pets,
  [`${ROOT}/samples/jetbrains.http`]: jetbrains,
};
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
type EnvMap = Record<string, Record<string, unknown>>;
type MockEnvVar = { name: string; value: string; secret: boolean };
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
  recentWorkspaces: [ROOT],
  environments: { [ROOT]: "local" },
  theme: new URLSearchParams(location.search).get("theme") ?? "system",
  layout: new URLSearchParams(location.search).get("layout") ?? "horizontal",
  checkUpdates: true,
  showDescriptions: true,
  sidebarWidth: 280,
  splitRatio: { horizontal: 0.5, vertical: 0.5 },
};
// Saved settings survive a reload of the page (like the real settings file), so
// a test can check something is still applied after `page.reload()`. Each test
// gets a fresh page, so it still starts from the defaults above.
const SAVED_SETTINGS = "httpdesk-mock-settings";
const saved = sessionStorage.getItem(SAVED_SETTINGS);
if (saved) settings = JSON.parse(saved);

/** Browser tests read this (see `sentRequests` in e2e/helpers.ts). */
const sent: unknown[] = [];
let settingsServed = false;
(window as unknown as { __mock: unknown }).__mock = {
  sent,
  /** Whether the app has been given its settings yet. */
  get settingsServed() {
    return settingsServed;
  },
  /** Lets held settings through (`?settingsDelay=hold`). */
  releaseSettings: () => releaseSettings(),
  get settings() {
    return clone(settings);
  },
  /** The `.http` file models as last saved, by path (the mock has no serializer). */
  get files() {
    return clone(files);
  },
  /** The two env files as last written (see `splitEnvFiles`). */
  get envFiles() {
    return clone(envFiles);
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
// `?sendError=<kind>`: every send fails with that kind of classified error (see `SendError`).
const sendErrorKind = new URLSearchParams(location.search).get("sendError");
const chain = (cause: string) => `error sending request for url (http://api.exmaple.com/pets): client error (Connect): ${cause}`;
const sendErrors: Record<string, { message: string; details: unknown }> = {
  dns: { message: chain("dns error: failed to lookup address information"), details: { host: "api.exmaple.com" } },
  refused: { message: chain("tcp connect error: Connection refused (os error 61)"), details: { host: "127.0.0.1", port: 8765 } },
  reset: { message: chain("connection closed before message completed"), details: { host: "127.0.0.1", port: 8765 } },
  tls: { message: chain("invalid peer certificate: UnknownIssuer"), details: { reason: "selfSigned" } },
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
  other: { message: "Something unexpected went wrong", details: null },
};
const sendError = sendErrorKind && sendErrors[sendErrorKind] ? { kind: sendErrorKind, ...sendErrors[sendErrorKind] } : null;
// `?manyHeaders=1`: the JSON response also carries caching, CORS and rate-limit headers.
const manyHeaders = new URLSearchParams(location.search).get("manyHeaders") === "1";
const extraHeaders: [string, string][] = manyHeaders
  ? [["cache-control", "public, max-age=60"], ["etag", '"pets-v1"'], ["x-cache", "HIT"], ["access-control-allow-origin", "*"], ["ratelimit-remaining", "42"]]
  : [];
// `?response=gzip`: the JSON response arrives gzip-encoded (fewer bytes on the wire than decoded).
// `?response=bigint`: the JSON response carries an ID above 2^53 and a `10.50`.
// `?response=invalidJson`: a JSON content type with a body that doesn't parse.
const responseKind = new URLSearchParams(location.search).get("response");
// `?download=slow`: the send takes ~2 s, its body "arriving" as `send-progress`
// events (bytes so far) every 100 ms, like the shell emits for a slow download.
const slowDownload = new URLSearchParams(location.search).get("download") === "slow";
// `?status=422`: the JSON response comes back with this status code instead.
const statusParam = Number(new URLSearchParams(location.search).get("status")) || null;
const reasonPhrases: Record<number, string> = { 200: "OK", 201: "Created", 404: "Not Found", 422: "Unprocessable Content", 500: "Internal Server Error" };
// `?bigBinary=1`: the image response is a 2 MB binary body instead of a small PNG.
const bigBinary = new URLSearchParams(location.search).get("bigBinary") === "1";
const BIG_BINARY_BYTES = 2 * 1024 * 1024;
// `?settingsDelay=<ms>`: settings arrive late, as on a slow start.
// `?settingsDelay=hold`: settings wait until a test calls `__mock.releaseSettings()`.
const settingsDelayParam = new URLSearchParams(location.search).get("settingsDelay");
const settingsHeld = settingsDelayParam === "hold";
const settingsDelay = settingsHeld ? 0 : Number(settingsDelayParam ?? 0);
let releaseSettings: () => void = () => {};
const settingsReleased = settingsHeld ? new Promise<void>((r) => (releaseSettings = r)) : Promise.resolve();

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
  if (Math.floor((b64.length * 3) / 4) - (b64.match(/=*$/)?.[0].length ?? 0) > limit) lines.push("… (truncated preview)");
  return lines.join("\n");
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

mockWindows("main");
mockIPC(
  async (cmd, args: any) => {
    switch (cmd) {
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
        return { root: ROOT, tree, gitignoreUpdated: false };
      case "get_tree":
        return tree;
      case "load_environments":
        return clone(envSet);
      case "save_environments":
        envSet = args.set;
        envFiles = splitEnvFiles(envSet, envFiles);
        return { gitignoreUpdated: false };
      case "read_http_file":
        return clone(files[args.path]);
      case "save_http_file":
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
      case "render_request": {
        const r = args.request;
        return `### ${r.name}\n${r.method} ${r.url}\n${r.headers.items.map((h: any) => `${h.enabled ? "" : "#~ "}${h.name}: ${h.value}`).join("\n")}\n`;
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
      case "send_request": {
        sent.push(clone(args.request));
        if (slowDownload) {
          for (let i = 1; i <= 20; i++) {
            await delay(100);
            await emit("send-progress", { runId: args.runId, received: i * 6_000 });
          }
        } else {
          await delay(450);
        }
        if (sendError) throw clone(sendError);
        const r = args.request;
        if (r.url.includes("png") && bigBinary) {
          return storeBinary({
            id: "r3", status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "http://127.0.0.1:8765/png/1",
            headers: [["content-type", "application/octet-stream"], ["content-length", String(BIG_BINARY_BYTES)]], timeMs: 52.3, ttfbMs: 10.1,
            bodySize: BIG_BINARY_BYTES, transferredSize: BIG_BINARY_BYTES, headersSize: 60, contentType: "application/octet-stream", contentEncoding: null, bodyText: null,
            bodyBase64: "AAAA".repeat(Math.floor(BIG_BINARY_BYTES / 3)) + "AAA=", // 2 MB of zero bytes (2 MB = 3n + 2)
            truncated: false, request: { method: "GET", url: "http://127.0.0.1:8765/png/1", headers: [], bodyPreview: null, bodySize: 0 }, warnings: [],
          });
        }
        if (r.url.includes("png")) {
          return storeBinary({
            id: "r2", status: 200, statusText: "OK", httpVersion: "HTTP/1.1", url: "http://127.0.0.1:8765/png/1",
            headers: [["content-type", "image/png"], ["content-length", "2749"]], timeMs: 12.3, ttfbMs: 10.1, bodySize: 2749, transferredSize: 2749, headersSize: 60,
            contentType: "image/png", contentEncoding: null, bodyText: null,
            bodyBase64: "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",
            truncated: false, request: { method: "GET", url: "http://127.0.0.1:8765/png/1", headers: [], bodyPreview: null, bodySize: 0 }, warnings: [],
          });
        }
        const body =
          responseKind === "bigint"
            ? `{"items":[{"id":9007199254740993,"price":10.50,"name":"Rex"}],"method":"${r.method}"}`
            : responseKind === "invalidJson"
              ? `{"id": 9007199254740993, oops}`
              : JSON.stringify({ items: [{ id: 1, name: "Rex", tags: ["good", "dog"], active: true }, { id: 2, name: "Tom", tags: [], active: false, owner: null }], method: r.method });
        const gzip = responseKind === "gzip";
        const transferredSize = gzip ? 112 : body.length;
        const status = statusParam ?? (r.method === "POST" ? 201 : 200);
        return {
          id: "r1", status, statusText: reasonPhrases[status] ?? "", httpVersion: "HTTP/1.1",
          url: "http://127.0.0.1:8765/pets?limit=20",
          headers: [["content-type", "application/json"], ...(gzip ? [["content-encoding", "gzip"]] : []), ["content-length", String(transferredSize)], ["x-powered-by", "echo"], ["date", "Wed, 04 Nov 2026 07:00:00 GMT"], ...extraHeaders],
          timeMs: 38.4, ttfbMs: 31.2, bodySize: body.length, transferredSize, headersSize: 120, contentType: "application/json", contentEncoding: gzip ? "gzip" : null,
          bodyText: body, bodyBase64: null, truncated: false,
          request: {
            method: r.method, url: "http://127.0.0.1:8765/pets?limit=20",
            headers: [["Authorization", "Bearer dev-token-123"], ["Accept", "application/json"], ["User-Agent", "HttpDesk/0.1.0"], ["Accept-Encoding", "gzip, deflate, br, zstd"]], bodyPreview: null, bodySize: 0,
          },
          warnings: [],
        };
      }
      case "format_body":
        if (args.kind === "xml") return formatXml(args.text, args.mode);
        try {
          return formatJson(args.text, args.mode);
        } catch (e) {
          throw `Invalid JSON: ${e instanceof Error ? e.message : e}`;
        }
      case "hexdump": {
        const b64 = binaryBodies.get(args.responseId);
        if (b64 === undefined) throw "Response is no longer available";
        return hexdump(b64);
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
