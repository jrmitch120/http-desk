// Typed wrappers around Tauri commands (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BodyKind,
  FilterResult,
  FormatMode,
  EnvironmentSet,
  GenerateOptions,
  GenerateReport,
  HttpFile,
  HttpResponse,
  Request,
  SearchHit,
  SpecSummary,
  TreeNode,
  Variable,
  WorkspaceInfo,
} from "./types";

export const api = {
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  getTree: () => invoke<TreeNode>("get_tree"),
  searchRequests: (query: string) => invoke<SearchHit[]>("search_requests", { query }),

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

  loadEnvironments: () => invoke<EnvironmentSet>("load_environments"),
  saveEnvironments: (set: EnvironmentSet) => invoke<{ gitignoreUpdated: boolean }>("save_environments", { set }),

  sendRequest: (args: {
    runId: string;
    request: Request;
    filePath: string | null;
    fileVariables: Variable[];
    environment: string | null;
  }) => invoke<HttpResponse>("send_request", args),
  cancelRequest: (runId: string) => invoke<void>("cancel_request", { runId }),
  saveResponseBody: (responseId: string, path: string) => invoke<void>("save_response_body", { responseId, path }),
  /**
   * Re-lays out a body in the core without changing any token (numbers and
   * strings stay exactly as written). Rejects with a message for invalid input.
   */
  formatBody: (text: string, kind: BodyKind, mode: FormatMode) => invoke<string>("format_body", { text, kind, mode }),
  /**
   * Runs an RFC 9535 JSONPath expression against a stored response body in the
   * core. Rejects with a message for an invalid expression or a non-JSON body.
   */
  filterResponse: (responseId: string, expression: string) => invoke<FilterResult>("filter_response", { responseId, expression }),

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
