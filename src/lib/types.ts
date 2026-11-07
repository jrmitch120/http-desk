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

/**
 * The field of a request a `{{reference}}` is in (core `workspace::RequestField`).
 * `index` counts into `query.items`, `headers.items` or `variables`; `url` is the
 * URL without its query string; `body` is `body.text` in any mode.
 */
export type UsageField =
  | { kind: "url" }
  | { kind: "param" | "header"; index: number; name: string; part: "name" | "value" }
  | { kind: "auth"; part: "username" | "password" | "token" | "keyValue" }
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
}

export interface EnvironmentSet {
  shared: EnvVar[];
  environments: Environment[];
  privateFileIgnored: boolean | null;
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
  /** What the body is, decided by the core from the content type (else the text). */
  bodyKind: ResponseKind;
  /** The response's Content-Encoding header, if any. */
  contentEncoding: string | null;
  bodyText: string | null;
  /**
   * The Pretty view's text, formatted by the shell, for a small JSON or XML
   * body (its raw text if it doesn't parse). Null for other bodies, and for
   * large ones: fetch those with `api.prettyResponse` when Pretty is opened.
   */
  prettyText: string | null;
  bodyBase64: string | null;
  truncated: boolean;
  request: SentRequest;
  warnings: string[];
  timings: Timings;
  /** Every Set-Cookie received, redirect hops first. Shown only; never sent back. */
  cookies: ResponseCookie[];
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
  | { kind: "other"; details: null }
);

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
  /** Sidebar width in px. */
  sidebarWidth: number;
  /** Request pane's share (0..1) of the request/response split, per layout. */
  splitRatio: Record<AppSettings["layout"], number>;
  /** Show the resolved preview under the URL bar. */
  showResolved: boolean;
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
