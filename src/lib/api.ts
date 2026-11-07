// Typed wrappers around Tauri commands (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BodyKind,
  FilterResult,
  FormatMode,
  JsonShape,
  EnvironmentSet,
  FolderEnvironments,
  GenerateOptions,
  GenerateReport,
  HttpFile,
  Usage,
  HttpResponse,
  Request,
  RequestPreview,
  SearchHit,
  SpecSummary,
  TreeNode,
  Variable,
  WorkspaceInfo,
} from "./types";

/** A request with the scope it's sent in, as `send_request` and `preview_request` take it. */
export type RequestArgs = {
  request: Request;
  filePath: string | null;
  fileVariables: Variable[];
  environment: string | null;
  /** Values remembered for the request's Prompt variables, by name. Never written anywhere. */
  promptValues: Record<string, string>;
};

export const api = {
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  getTree: () => invoke<TreeNode>("get_tree"),
  searchRequests: (query: string) => invoke<SearchHit[]>("search_requests", { query }),
  /** Find usages of `{{name}}`; `open` documents are searched as given (unsaved edits included). */
  findUsages: (name: string, open: { path: string; file: HttpFile }[]) => invoke<Usage[]>("find_usages", { name, open }),

  readHttpFile: (path: string) => invoke<HttpFile>("read_http_file", { path }),
  saveHttpFile: (path: string, file: HttpFile) => invoke<HttpFile>("save_http_file", { path, file }),
  renderRequest: (request: Request) => invoke<string>("render_request", { request }),
  createFile: (path: string, content: string) => invoke<void>("create_file", { path, content }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  /** Moves to the OS trash; never unlinks. "trashUnavailable" leaves the entry in place. */
  deletePath: (path: string) => invoke<"trashed" | "trashUnavailable">("delete_path", { path }),
  /** Unlinks for good. Only call after the user confirmed it. */
  deletePermanently: (path: string) => invoke<void>("delete_permanently", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),

  /** Folder `dir`'s own pair of env files (relative to the root, `/`-separated; the root's by default). */
  loadEnvironments: (dir = "") => invoke<EnvironmentSet>("load_environments", { dir }),
  /** Each folder below the root with env files, with the environments its requests get (ADR-0004). */
  loadFolderEnvironments: () => invoke<FolderEnvironments[]>("load_folder_environments"),
  /** Saves `set` as folder `dir`'s own pair of env files (the root's by default). */
  saveEnvironments: (set: EnvironmentSet, dir = "") => invoke<{ gitignoreUpdated: boolean }>("save_environments", { set, dir }),

  sendRequest: (args: RequestArgs & { runId: string }) => invoke<HttpResponse>("send_request", args),
  /** What `sendRequest` with the same arguments would send, without sending it. */
  previewRequest: (args: RequestArgs) => invoke<RequestPreview>("preview_request", args),
  cancelRequest: (runId: string) => invoke<void>("cancel_request", { runId }),
  saveResponseBody: (responseId: string, path: string) => invoke<void>("save_response_body", { responseId, path }),
  /**
   * Re-lays out a body in the core without changing any token (numbers and
   * strings stay exactly as written). Rejects with a message for invalid input.
   */
  formatBody: (text: string, kind: BodyKind, mode: FormatMode) => invoke<string>("format_body", { text, kind, mode }),
  /**
   * The Hex view of a binary response: a dump of the first 64 KB of the body
   * the shell stored for it. Rejects once the body has been evicted.
   */
  hexdump: (responseId: string) => invoke<string>("hexdump", { responseId }),
  /**
   * Runs an RFC 9535 JSONPath expression against a stored response body in the
   * core. Rejects with a message for an invalid expression or a non-JSON body.
   */
  filterResponse: (responseId: string, expression: string) => invoke<FilterResult>("filter_response", { responseId, expression }),
  /**
   * The Pretty view of a response too large to arrive with its `prettyText`,
   * formatted from the body the shell stored. Rejects when it doesn't parse or
   * has been evicted.
   */
  prettyResponse: (responseId: string) => invoke<string>("pretty_response", { responseId }),
  /** The keys reachable at each place in a stored JSON response body, for filter key completion. */
  responseShape: (responseId: string) => invoke<JsonShape>("response_shape", { responseId }),

  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  /** Whether any open file has unsaved edits (macOS asks before a logout then). */
  setUnsaved: (unsaved: boolean) => invoke<void>("set_unsaved", { unsaved }),

  openapiLoad: (source: string) => invoke<SpecSummary>("openapi_load", { source }),
  openapiGenerate: (args: {
    source: string;
    options: GenerateOptions;
    outputDir: string;
    overwrite: boolean;
    dryRun: boolean;
  }) => invoke<GenerateReport>("openapi_generate", args),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
