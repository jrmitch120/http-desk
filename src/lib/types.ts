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

export interface KeyValue {
  enabled: boolean;
  name: string;
  value: string;
  /** Params/headers only: saved as `# @param name: …` / `# @header Name: …`. */
  description?: string;
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

export interface HttpResponse {
  id: string;
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: [string, string][];
  timeMs: number;
  ttfbMs: number;
  bodySize: number;
  headersSize: number;
  contentType: string | null;
  bodyText: string | null;
  bodyBase64: string | null;
  truncated: boolean;
  request: SentRequest;
  warnings: string[];
}

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

export interface AppSettings {
  exec: ExecSettings;
  recentWorkspaces: string[];
  environments: Record<string, string>;
  theme: "dark" | "light";
  layout: "horizontal" | "vertical";
  checkUpdates: boolean;
  showDescriptions: boolean;
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
