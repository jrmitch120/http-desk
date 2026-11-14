// Typed wrappers around Tauri commands (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
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
import type { MenuItemChange, NativeMenu } from "./menuLayout";

/** A request with the scope it's sent in, as `send_request` and `preview_request` take it. */
export type RequestArgs = {
  request: Request;
  filePath: string | null;
  fileVariables: Variable[];
  environment: string | null;
  /** The request's key (`_key`): its Prompt variables take the answers the Session holds for it. */
  requestKey: string;
  /** The `# @name`s of the file's requests (`requestNames`): its Request variables read their latest exchanges in the Session. */
  requestNames: string[];
};

/** Which form of a stored response body `api.responseBody` fetches. */
export type BodyFetchView = "raw" | "pretty" | "bytes";

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

  /** Sends the request, then runs its response handler unless `skipScripts`. A request
   *  with a script in a workspace that isn't trusted fails `untrustedWorkspace`, unsent. */
  sendRequest: (args: RequestArgs & { runId: string; skipScripts?: boolean }) => invoke<HttpResponse>("send_request", args),
  /** What `sendRequest` with the same arguments would send, without sending it. */
  previewRequest: (args: RequestArgs) => invoke<RequestPreview>("preview_request", args),
  cancelRequest: (runId: string) => invoke<void>("cancel_request", { runId }),
  /** Rejects with why a script file reference (`path`, written in the file at `filePath`) can't run: missing, or outside the workspace. */
  checkScriptFile: (filePath: string | null, path: string) => invoke<void>("check_script_file", { filePath, path }),
  /** Opens a script file reference in the default editor (a `.js` file inside the workspace only). */
  openScriptFile: (filePath: string | null, path: string) => invoke<void>("open_script_file", { filePath, path }),
  /** The answers the workspace's Session holds for a request's Prompt variables, by name. */
  promptAnswers: (requestKey: string) => invoke<Record<string, string>>("prompt_answers", { requestKey }),
  /** Has the Session remember answers to a request's Prompt variables (in memory only). */
  answerPrompts: (requestKey: string, answers: Record<string, string>) => invoke<void>("answer_prompts", { requestKey, answers }),
  /** Forgets a request's Prompt variable answers, so its next send asks again. */
  forgetPromptAnswers: (requestKey: string) => invoke<void>("forget_prompt_answers", { requestKey }),
  saveResponseBody: (responseId: string, path: string) => invoke<void>("save_response_body", { responseId, path }),
  /**
   * Lets the shell drop a response's body and everything cached from it, once no
   * tab shows it. Until then it's kept, however many other responses arrive.
   */
  releaseResponse: (responseId: string) => invoke<void>("release_response", { responseId }),
  /**
   * Copy body: the shell puts a stored body on the clipboard, text as text and
   * binary as base64, so the webview never holds it. Rejects when the body has
   * been released or the clipboard can't be written.
   */
  copyResponseBody: (responseId: string) => invoke<void>("copy_response_body", { responseId }),
  /**
   * Re-lays out a body in the core without changing any token (numbers and
   * strings stay exactly as written). Rejects with a message for invalid input.
   */
  formatBody: (text: string, kind: BodyKind, mode: FormatMode) => invoke<string>("format_body", { text, kind, mode }),
  /**
   * The Hex view of a binary response: a dump of the first 64 KB of the body
   * the shell stored for it. Rejects once the body has been released.
   */
  hexdump: (responseId: string) => invoke<string>("hexdump", { responseId }),
  /**
   * Runs an RFC 9535 JSONPath expression against a stored response body in the
   * core. Rejects with a message for an invalid expression or a non-JSON body.
   */
  filterResponse: (responseId: string, expression: string) => invoke<FilterResult>("filter_response", { responseId, expression }),
  /**
   * A stored response body as raw bytes: its text (`raw`, decoded from the
   * declared charset) or Pretty text (`pretty`, lossless JSON or XML) as UTF-8,
   * or the body's own `bytes`. Rejects when the body has been released, isn't
   * text (its kind is binary), or has no Pretty text (not JSON or XML, or it doesn't parse).
   */
  responseBody: (responseId: string, view: BodyFetchView) => invoke<ArrayBuffer>("response_body", { responseId, view }),
  /** The keys reachable at each place in a stored JSON response body, for filter key completion. */
  responseShape: (responseId: string) => invoke<JsonShape>("response_shape", { responseId }),

  getSettings: () => invoke<AppSettings>("get_settings"),
  /** Saves the settings; `trustedWorkspaces` is the shell's and stays as it is. */
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  /** Makes the open workspace a Trusted workspace; returns every Trusted workspace. */
  trustWorkspace: () => invoke<string[]>("trust_workspace"),
  /** Stops trusting the workspace at `path`; returns the Trusted workspaces left. */
  revokeWorkspaceTrust: (path: string) => invoke<string[]>("revoke_workspace_trust", { path }),
  /** Whether any open file has unsaved edits (macOS asks before a logout then). */
  setUnsaved: (unsaved: boolean) => invoke<void>("set_unsaved", { unsaved }),

  /** The app's version, OS and architecture (About HttpDesk, Report an Issue). */
  appInfo: () => invoke<AppInfo>("app_info"),

  /** Builds the native menu bar from `layout` (src-tauri/src/menu.rs), replacing the one before. */
  setMenu: (layout: NativeMenu) => invoke<void>("set_menu", { layout }),
  /** Greys out, enables, ticks or unticks the native menu's items by id. */
  setMenuState: (changes: MenuItemChange[]) => invoke<void>("set_menu_state", { changes }),

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
