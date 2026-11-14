// TypeScript mirror of the Rust model (crates/httpdesk-core/src/model.rs etc.).
// Keep in sync when changing serde structs.

export type LineEnding = "lf" | "crlf";

export interface Variable {
  name: string;
  value: string;
}

export interface Directive {
  name: string;
  value: string;
}

/** A Prompt variable: `# @prompt name [description]` asks for a value at send. */
export interface Prompt {
  name: string;
  /** Help text for the field; empty when the line has none. */
  description: string;
}

export interface KeyValue {
  enabled: boolean;
  name: string;
  value: string;
  /** Params/headers only: saved as `# @param name: …` / `# @header Name: …`. */
  description?: string;
  /** Query params only: an empty value is written `name=` rather than `name`. */
  equals?: boolean;
}

export interface KvSection {
  enabled: boolean;
  items: KeyValue[];
}

export type AuthKind = "none" | "basic" | "bearer" | "apiKey";
export type ApiKeyLocation = "header" | "query";

export interface Auth {
  enabled: boolean;
  kind: AuthKind;
  username: string;
  password: string;
  token: string;
  keyName: string;
  keyValue: string;
  keyLocation: ApiKeyLocation;
  /** `Authorization` value as written; reused while it carries the same credentials. */
  raw: string | null;
}

export type BodyMode = "none" | "json" | "xml" | "text" | "formUrlEncoded" | "multipart" | "file" | "raw";

export interface Body {
  enabled: boolean;
  mode: BodyMode;
  text: string;
}

/** An unrecognized header-area line, kept verbatim and in place. */
export interface ExtraLine {
  text: string;
  /** Header name (or `&name` for a disabled query param) the line sat above; null = after the headers. */
  before: string | null;
}

export interface Request {
  name: string;
  comments: string[];
  directives: Directive[];
  variables: Variable[];
  preScript: string | null;
  method: string;
  url: string;
  httpVersion: string | null;
  query: KvSection;
  headers: KvSection;
  auth: Auth;
  body: Body;
  extraLines: ExtraLine[];
  responseHandler: string | null;
  leading: string;
  raw: string | null;
  /** Frontend-only stable identity (ignored by the backend). */
  _key?: string;
}

export interface FileHeader {
  comments: string[];
  variables: Variable[];
  raw: string | null;
}

export interface HttpFile {
  header: FileHeader;
  requests: Request[];
  trailing: string;
  lineEnding: LineEnding;
  /** The file started with a UTF-8 BOM; written back on save. */
  bom: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: TreeNode[];
}

export interface WorkspaceInfo {
  root: string;
  tree: TreeNode;
  /** Opening added the private env file to the workspace `.gitignore`. */
  gitignoreUpdated: boolean;
}

export interface SearchHit {
  path: string;
  index: number;
  name: string;
  method: string;
  url: string;
}

/** An auth field that can hold references (core `workspace::AuthPart`): the `Auth`
 *  property of that name. `keyName` only for a query API key, whose name is resolved at send. */
export type AuthPart = "username" | "password" | "token" | "keyName" | "keyValue";

/**
 * The field of a request a `{{reference}}` is in (core `workspace::RequestField`).
 * `index` counts into `query.items`, `headers.items` or `variables`; `url` is the
 * URL without its query string; `body` is `body.text` in any mode.
 */
export type UsageField =
  | { kind: "url" }
  | { kind: "param" | "header"; index: number; name: string; part: "name" | "value" }
  | { kind: "auth"; part: AuthPart }
  | { kind: "body" }
  | { kind: "variable"; index: number; name: string };

/**
 * One `{{name}}` reference found by Find usages (core `workspace::Usage`).
 * `start`..`end` is where it sits in its field's text, braces included, in
 * UTF-16 code units (so `text.slice(start, end)` is the reference as written).
 * - `request`: in a request, identified as a `SearchHit` is; `disabled` when it isn't sent.
 * - `fileVariable`: in the value of `file.header.variables[index]` (named `name`).
 * - `environment`: in the value of variable `name` of `env` (`$shared` for the
 *   shared variables); `path` is the env file holding it (the private one for a Secret).
 */
export type Usage =
  | ({ kind: "request"; field: UsageField; disabled: boolean; start: number; end: number } & SearchHit)
  | { kind: "fileVariable"; path: string; index: number; name: string; start: number; end: number }
  | { kind: "environment"; path: string; env: string; name: string; secret: boolean; start: number; end: number };

/** JSON type an env value was read with; saving writes it back with it (missing = string). */
export type JsonType = "string" | "number" | "boolean" | "null";

export interface EnvVar {
  name: string;
  value: string;
  secret: boolean;
  jsonType?: JsonType;
}

export interface Environment {
  name: string;
  variables: EnvVar[];
  /** The folders whose files supply it, in the sets the core loads for requests; ignored on save. */
  source?: EnvSource;
}

/**
 * Which folders supply an environment (or the shared variables) to a folder's
 * requests (ADR-0004): the nearest whose public file defines it and the nearest whose
 * private file does, relative to the workspace root (`""` for the root). A Secret's
 * value comes from `private`, any other from `public` (core `env::EnvSource`).
 */
export interface EnvSource {
  public?: string | null;
  private?: string | null;
}

export interface EnvironmentSet {
  shared: EnvVar[];
  environments: Environment[];
  privateFileIgnored: boolean | null;
  /** The folders supplying the shared variables (see `Environment.source`). */
  sharedSource?: EnvSource | null;
}

/**
 * The environments of the requests in a folder below the workspace root that has env
 * files of its own (and in its subfolders that have none): core `env::FolderEnvironments`.
 */
export interface FolderEnvironments {
  /** Relative to the workspace root, `/`-separated (`api/users`). */
  dir: string;
  set: EnvironmentSet;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: [string, string][];
  bodyPreview: string | null;
  bodySize: number;
}

/**
 * The resolved preview (`preview_request`, core `exec::RequestPreview`): what a
 * send would send, without sending. Dynamic variables that generate a value on
 * every send stay as written (`{{$uuid}}`); the body isn't included.
 */
export interface RequestPreview {
  method: string;
  /** As sent: query params encoded per ADR-0001. */
  url: string;
  /** Every header sent, including the auth header, the Content-Type the body implies and the defaults. */
  headers: [string, string][];
  /** The enabled auth's fields resolved, labelled as in the Authorization section. */
  auth: [string, string][];
  warnings: string[];
  /** Why a send would fail before reaching the network. */
  error: SendError | null;
}

export interface HttpResponse {
  id: string;
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: [string, string][];
  timeMs: number;
  ttfbMs: number;
  /** Decoded body size. */
  bodySize: number;
  /** Body bytes as received on the wire, before Content-Encoding is undone. */
  transferredSize: number;
  headersSize: number;
  contentType: string | null;
  /**
   * What the body is, decided by the core from the content type (else the text);
   * it says whether the body is text or binary. The reply carries no body: the
   * viewer fetches it by response id (`api.responseBody`).
   */
  bodyKind: ResponseKind;
  /** The response's Content-Encoding header, if any. */
  contentEncoding: string | null;
  truncated: boolean;
  request: SentRequest;
  warnings: string[];
  timings: Timings;
  /** Every Set-Cookie received, redirect hops first. The Session's jar keeps them and sends them back. */
  cookies: ResponseCookie[];
  /** The response handler's `client.test`/`client.assert` results and its own
   *  failure, if any. Empty when no handler ran (`httpdesk_core::script`). */
  tests: TestResult[];
  /** What the scripts logged with `client.log`, a line per call, in order. */
  logs: string[];
}

/**
 * A `run-progress` event (`RunProgress` in src-tauri/src/lib.rs): what happened to
 * request `index` of run `runId`. Each request reports `sending`, then one of the
 * others; a request the run never reached reports nothing. `failed` follows GLOSSARY
 * "Run": a failed test or script error, not an error status alone. A `failed` state
 * (blocked, or no response) is always a failure.
 */
export type RunProgress = { runId: string; index: number } & (
  | { state: "sending" }
  | { state: "sent"; response: HttpResponse; failed: boolean }
  | { state: "failed"; error: unknown }
  | { state: "cancelled" }
);

/** One `client.test`, top-level `client.assert`, or script error (`script::TestResult`). */
export interface TestResult {
  name: string;
  passed: boolean;
  /** Why it failed; null when it passed. */
  message: string | null;
}

/**
 * Phase timing of the final request after redirects, in ms (`timeMs` covers
 * every hop). A phase that wasn't measured is absent, not zero: DNS and
 * connect on a reused connection, DNS for an IP address.
 */
export interface Timings {
  dns?: number;
  /** TCP connect plus the TLS handshake for https. */
  connect?: number;
  ttfb: number;
  download: number;
  reused: boolean;
  redirects: number;
}

/** One Set-Cookie header, parsed in the core (`httpdesk_core::cookies::ResponseCookie`). */
export interface ResponseCookie {
  name: string;
  value: string;
  /** Without a leading dot; null means host-only. */
  domain: string | null;
  path: string | null;
  /** RFC 3339 UTC. */
  expires: string | null;
  /** Seconds; wins over `expires` when both are set. */
  maxAge: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None" | null;
  /** The URL of the response that set it (a redirect hop or the final one). */
  url: string;
  /** The header value as received. */
  raw: string;
  /** Set when the header couldn't be read as a cookie; the other fields are then empty. */
  parseError: string | null;
}

/**
 * A cookie in the Session's jar (`httpdesk_core::cookies::StoredCookie`). Its
 * domain, path and name identify it.
 */
export interface StoredCookie {
  name: string;
  value: string;
  /** The host it is sent to, without a leading dot; its subdomains too unless `hostOnly`. */
  domain: string;
  /** Set without a Domain attribute, so sent to exactly `domain`. */
  hostOnly: boolean;
  path: string;
  /** RFC 3339 UTC; absent for a cookie that lasts until the Session ends. */
  expires?: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None" | null;
}

/** The syntax `format_body` formats (core `body_format::BodyKind`). */
export type BodyKind = "json" | "xml";

/** What a response body is (core `body_format::ResponseKind`): its views, highlighting and Save extension. */
export type ResponseKind = "json" | "html" | "xml" | "image" | "pdf" | "media" | "text" | "binary";

/** Pretty: one member per line, two-space indent. Minify: no whitespace. */
export type FormatMode = "pretty" | "minify";

/** What a JSONPath filter selected (core `json_filter::FilterResult`). */
export interface FilterResult {
  matches: number;
  /** The matches as a pretty-printed JSON array, numbers as the server sent them. */
  text: string;
}

/**
 * The keys reachable at each place in a JSON body (core `json_filter::Shape`),
 * for filter key completion. `keys` are `[name, shape]` pairs in document
 * order; `items` is the merged shape of array elements (present for any array).
 */
export interface JsonShape {
  keys?: [string, JsonShape][];
  items?: JsonShape;
}

/**
 * A named request's latest exchange in the Session as completion (and its hover)
 * sees it (core `exchange::ExchangeShape`): when it arrived, its status, and each
 * side's header names and JSON body shape.
 */
export interface ExchangeShape {
  /** RFC 3339, UTC. */
  received: string;
  status: number;
  response: MessageShape;
  request: MessageShape;
}

/** One side of an exchange (core `exchange::MessageShape`). */
export interface MessageShape {
  /** Header names in order, each once. */
  headers: string[];
  /** Null when the body isn't JSON (or there's none). */
  body: JsonShape | null;
}

/** Why a send failed; mirrors the core's `ExecError` kinds. */
export type TlsReason = "selfSigned" | "expired" | "wrongHost" | "unknownIssuer" | "other";

/**
 * A failed send as `send_request` rejects with it (core `ExecError`, kinds
 * from `exec::ErrorKind`). `message` is the core's explanation (for transport
 * errors, the full error chain); `details` depends on `kind`.
 */
export type SendError = { message: string } & (
  | { kind: "dns"; details: { host: string } }
  | { kind: "refused" | "reset"; details: { host: string; port: number } }
  | { kind: "tls"; details: { reason: TlsReason } }
  | { kind: "timeoutIdle" | "timeoutConnect"; details: { timeoutMs: number } }
  | { kind: "invalidUrl"; details: { url: string; reason: string } }
  | { kind: "unresolvedVariable"; details: { names: string[] } }
  /** Each chain is the names followed from the reference to the one that repeats: `["a", "b", "a"]`. */
  | { kind: "circularVariable"; details: { chains: string[][] } }
  | { kind: "file"; details: { path: string; reason: string } }
  /** The request has a script and the workspace isn't a Trusted workspace. */
  | { kind: "untrustedWorkspace"; details: null }
  /** The pre-request script failed, so nothing was sent. `line` counts from its first `<` line. */
  | { kind: "preRequestScript"; details: { line: number | null } }
  /** Request variables read the latest exchange of these named requests, which haven't been sent in this Session. */
  | { kind: "unsentRequest"; details: { names: string[] } }
  /** Request variables whose path reads nothing from their request's latest exchange. */
  | { kind: "unmatchedPath"; details: { paths: UnmatchedPath[] } }
  | { kind: "other"; details: null }
);

/** A Request variable whose path read nothing (the core's `exchange::UnmatchedPath`). */
export interface UnmatchedPath {
  /** As written between the braces, trimmed: `login.response.body.$.tok`. */
  reference: string;
  /** The `# @name` of the request whose latest exchange it looked in. */
  request: string;
  /** When that exchange's response arrived (RFC 3339). */
  received: string;
  reason: string;
}

export type SendErrorKind = SendError["kind"];

export interface ExecSettings {
  timeoutMs: number;
  connectTimeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  caCertPath: string | null;
  clientCertPath: string | null;
  clientKeyPath: string | null;
  maxBodyBytes: number;
}

/** Settings of one environment that aren't variables. */
export interface EnvironmentSettings {
  /** Sending anything but GET, HEAD or OPTIONS asks for confirmation first. */
  production?: boolean;
  /** A colour name from `ENV_COLORS` (src/lib/envColors.ts) tinting the top bar. */
  color?: string | null;
}

/** Which HttpDesk this is (the shell's `app_info`). */
export interface AppInfo {
  version: string;
  /** Rust's name for the OS: "macos", "windows", "linux". */
  os: string;
  /** Rust's name for the CPU architecture: "aarch64", "x86_64". */
  arch: string;
}

export interface AppSettings {
  exec: ExecSettings;
  recentWorkspaces: string[];
  environments: Record<string, string>;
  /** Per workspace root, then per environment name. Kept here, never in the env
   *  files, so other tools don't see extra keys they'd treat as variables. */
  environmentSettings: Record<string, Record<string, EnvironmentSettings>>;
  /** "system" follows the OS appearance (prefers-color-scheme). */
  theme: "system" | "light" | "dark";
  layout: "horizontal" | "vertical";
  checkUpdates: boolean;
  showDescriptions: boolean;
  /** Sidebar width in px, kept while the sidebar is hidden. */
  sidebarWidth: number;
  /** The sidebar is hidden (View → Show Sidebar, ⌘B / Ctrl+B). */
  sidebarHidden: boolean;
  /** Height in px of the panel area below the requests (View → Show Session). */
  panelHeight: number;
  /** The zoom of the whole interface, `1` being 100% (View → Zoom In / Zoom Out / Actual Size, ⌘= / ⌘- / ⌘0). */
  zoom: number;
  /** Request pane's share (0..1) of the request/response split, per layout. */
  splitRatio: Record<AppSettings["layout"], number>;
  /** Show the resolved preview under the URL bar. */
  showResolved: boolean;
  /** How the Environments modal shows variables: every environment side by side, or one at a time. */
  envView: "matrix" | "list";
  /** Per workspace root: the Environments matrix's column widths, as resized. */
  envMatrixWidths: Record<string, MatrixWidths>;
  /** Trusted workspaces (canonical roots): the only ones whose scripts run. Only the
   *  shell changes it (`api.trustWorkspace`/`api.revokeWorkspaceTrust`); a save keeps the shell's. */
  trustedWorkspaces: string[];
}

/** Column widths of the Environments matrix in one workspace, px. A column not listed keeps its default width. */
export interface MatrixWidths {
  /** The Variable column. */
  variable?: number | null;
  /** By column: `$shared` for the shared variables, else the environment's name. */
  columns: Record<string, number>;
}

// ---- OpenAPI

export interface ServerInfo {
  url: string;
  description: string | null;
}

export interface OperationInfo {
  id: string;
  method: string;
  path: string;
  summary: string | null;
  operationId: string | null;
  tags: string[];
  deprecated: boolean;
}

export interface SpecSummary {
  title: string;
  version: string;
  openapiVersion: string;
  description: string | null;
  servers: ServerInfo[];
  operations: OperationInfo[];
  tags: string[];
  warnings: string[];
}

export type Grouping = "tag" | "path" | "single";

export interface GenerateOptions {
  operationIds: string[];
  grouping: Grouping;
  baseUrlVariable: string;
  singleFileName: string | null;
  paramDescriptions: boolean;
}

export interface GenerateReport {
  files: string[];
  conflicts: string[];
  written: boolean;
  environments: string[];
  envDir: string;
  gitignoreUpdated: boolean;
  warnings: string[];
}
