//! Tauri shell: thin commands over `httpdesk-core`, plus the workspace file
//! watcher. All domain logic lives in the core crate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use httpdesk_core::body_format::{self, BodyKind, FormatMode};
use httpdesk_core::env::{self, EnvironmentSet, SaveReport};
use httpdesk_core::exec::{self, ExecError, ExecSettings, HttpResponse};
use httpdesk_core::json_filter::{FilterResult, JsonDocument, Shape};
use httpdesk_core::openapi::{GenerateOptions, OpenApiDoc, SpecSummary};
use httpdesk_core::vars::Resolver;
use httpdesk_core::workspace::{self, SearchHit, TreeNode, Usage};
use httpdesk_core::{HttpFile, Request, Variable};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

mod bodies;
mod confine;
mod deleting;
mod json_docs;
mod paths;
mod quit;
mod self_writes;
mod theme;
mod watcher;
use bodies::RecentBodies;
use deleting::{DeleteOutcome, Trash};
use json_docs::JsonDocs;
use self_writes::SelfWrites;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Runs a slow command body on the blocking pool, so a big workspace or a
/// large write never freezes the window (sync commands run on the main thread).
async fn off_main<R: tauri::Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(&AppState) -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>())).await.map_err(err)?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    exec: ExecSettings,
    recent_workspaces: Vec<PathBuf>,
    /// Last selected environment per workspace.
    environments: HashMap<String, String>,
    /// Per workspace, then per environment name: settings that aren't variables
    /// (production, colour), kept here so the env files only hold variables.
    environment_settings: HashMap<String, HashMap<String, EnvironmentSettings>>,
    /// "system" (follow the OS appearance), "light" or "dark".
    theme: String,
    layout: String,
    /// Look for a new release on startup.
    check_updates: bool,
    /// Show param/header descriptions under each row.
    show_descriptions: bool,
    /// Sidebar width in px. A float, so no value the frontend writes fails to load.
    sidebar_width: f64,
    /// The request pane's share of the request/response split, per layout.
    split_ratio: SplitRatio,
    /// Show the resolved preview under the URL bar.
    show_resolved: bool,
    /// How the Environments modal shows variables.
    #[serde(deserialize_with = "or_default")]
    env_view: EnvView,
    /// Per workspace: the Environments matrix's column widths, as the user resized them.
    #[serde(deserialize_with = "or_default")]
    env_matrix_widths: HashMap<String, MatrixWidths>,
}

/// Column widths of the Environments matrix in one workspace, px. Columns not
/// listed keep their default width.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MatrixWidths {
    /// The Variable column.
    variable: Option<f64>,
    /// By column: `$shared` for the shared variables, else the environment's name.
    columns: HashMap<String, f64>,
}

/// How the Environments modal shows variables (`envView` in the settings file).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EnvView {
    /// Every environment side by side.
    #[default]
    Matrix,
    /// One environment at a time.
    List,
}

/// Reads a settings field, taking the default for a value this version doesn't know
/// (a hand-edited file, or a newer version's), so one odd field doesn't drop the rest.
fn or_default<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// Settings of one environment (see `AppSettings::environment_settings`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct EnvironmentSettings {
    /// Sending anything but GET, HEAD or OPTIONS asks for confirmation first.
    production: bool,
    /// A colour name from the frontend's palette (src/lib/envColors.ts), or none.
    color: Option<String>,
}

/// Defaults must match `SIDEBAR`/`SPLIT` in src/lib/panes.ts (src/lib/panes.test.ts checks).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct SplitRatio {
    horizontal: f64,
    vertical: f64,
}

impl Default for SplitRatio {
    fn default() -> Self {
        SplitRatio { horizontal: 0.5, vertical: 0.5 }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            exec: ExecSettings::default(),
            recent_workspaces: vec![],
            environments: HashMap::new(),
            environment_settings: HashMap::new(),
            theme: "system".into(),
            layout: "horizontal".into(),
            check_updates: true,
            show_descriptions: true,
            sidebar_width: 280.0,
            split_ratio: SplitRatio::default(),
            show_resolved: false,
            env_view: EnvView::Matrix,
            env_matrix_widths: HashMap::new(),
        }
    }
}

#[derive(Default)]
struct AppState {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<watcher::Watcher>>,
    /// What our own file operations left on disk, to ignore their watcher events.
    self_writes: SelfWrites,
    trash: Trash,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Idle HTTP clients, so a send can reuse a connection an earlier one left open.
    clients: exec::ClientPool,
    /// Recent response bodies by response id (for "save to file").
    bodies: Mutex<RecentBodies>,
    /// Recent bodies parsed as JSON, by response id (for the filter bar).
    json_docs: Mutex<JsonDocs>,
    specs: Mutex<HashMap<String, OpenApiDoc>>,
    settings: Mutex<AppSettings>,
    /// Whether an open file has unsaved edits (reported by the frontend), so a
    /// logout asks first. See quit.rs.
    unsaved: AtomicBool,
}

impl AppState {
    fn root(&self) -> CmdResult<PathBuf> {
        self.root.lock().unwrap().clone().ok_or_else(|| "No workspace is open".to_string())
    }

    fn write_file(&self, path: &Path, text: &str) -> CmdResult<()> {
        self.self_writes.writing(path, text.as_bytes());
        workspace::write_atomic(path, text.as_bytes()).map_err(|e| format!("Could not write {}: {e}", path.display()))
    }
}

/// Managed state that gives one app instance its own config folder. The IPC tests
/// use it because `HTTPDESK_CONFIG_DIR` is shared by every app in the process.
#[cfg(test)]
struct ConfigDir(PathBuf);

/// `HTTPDESK_CONFIG_DIR` overrides the config location (portable installs).
fn settings_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = app.try_state::<ConfigDir>() {
        return Some(dir.0.join("settings.json"));
    }
    let dir =
        std::env::var_os("HTTPDESK_CONFIG_DIR").map(PathBuf::from).or_else(|| app.path().app_config_dir().ok())?;
    Some(dir.join("settings.json"))
}

fn persist_settings<R: tauri::Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> CmdResult<()> {
    let Some(path) = settings_path(app) else { return Ok(()) };
    write_settings(&path, settings).map_err(|e| format!("Could not save settings to {}: {e}", path.display()))
}

/// Recents in the form `open_workspace` now stores (older versions saved
/// `\\?\C:\…` on Windows), without the duplicates that leaves.
fn simplified_recents(recents: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in recents.iter().map(|p| paths::simplified(p)) {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Atomic, so a crash mid-save can't leave a truncated file that resets every setting.
fn write_settings(path: &Path, settings: &AppSettings) -> std::io::Result<()> {
    workspace::write_atomic(path, serde_json::to_string_pretty(settings).unwrap().as_bytes())
}

// ------------------------------------------------------------------ workspace

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: PathBuf,
    tree: TreeNode,
    /// Opening added the private env file to the workspace `.gitignore`.
    gitignore_updated: bool,
}

#[tauri::command]
async fn open_workspace<R: tauri::Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<WorkspaceInfo> {
    off_main(app.clone(), move |state| open_workspace_blocking(&app, state, path)).await
}

fn open_workspace_blocking<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    path: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let root = paths::canonicalize(&path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let tree = workspace::tree(&root).map_err(err)?;
    let watcher = watcher::start(app, state.self_writes.clone(), &root)?;
    *state.watcher.lock().unwrap() = Some(watcher);
    *state.root.lock().unwrap() = Some(root.clone());
    // Covers private env files created before HttpDesk handled workspaces inside a repo.
    let gitignore_updated = env::ensure_gitignored(&root).unwrap_or(false);

    let mut settings = state.settings.lock().unwrap();
    settings.recent_workspaces.retain(|p| p != &root);
    settings.recent_workspaces.insert(0, root.clone());
    settings.recent_workspaces.truncate(10);
    // The workspace is open either way; a lost recents entry isn't worth failing for.
    let _ = persist_settings(app, &settings);
    Ok(WorkspaceInfo { root, tree, gitignore_updated })
}

#[tauri::command]
async fn get_tree<R: tauri::Runtime>(app: AppHandle<R>) -> CmdResult<TreeNode> {
    off_main(app, |state| workspace::tree(&state.root()?).map_err(err)).await
}

#[tauri::command]
async fn search_requests<R: tauri::Runtime>(app: AppHandle<R>, query: String) -> CmdResult<Vec<SearchHit>> {
    off_main(app, move |state| Ok(workspace::search(&state.root()?, &query))).await
}

/// A document as the app has it, unsaved edits included.
#[derive(Debug, Deserialize)]
struct OpenDoc {
    path: PathBuf,
    file: HttpFile,
}

/// Find usages: every `{{name}}` reference in the workspace's `.http` files and
/// env files. `open` documents are searched as given instead of from disk.
#[tauri::command]
async fn find_usages<R: tauri::Runtime>(app: AppHandle<R>, name: String, open: Vec<OpenDoc>) -> CmdResult<Vec<Usage>> {
    let open: Vec<_> = open.into_iter().map(|d| (d.path, d.file)).collect();
    off_main(app, move |state| Ok(workspace::usages(&state.root()?, &name, &open))).await
}

// ------------------------------------------------------------------ files

#[tauri::command]
fn read_http_file(state: State<'_, AppState>, path: PathBuf) -> CmdResult<HttpFile> {
    let path = state.confine_entry(&path)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Ok(httpdesk_core::parse(&text))
}

/// Serializes and writes the file, returning it re-parsed (fresh `raw` snapshots).
#[tauri::command]
fn save_http_file(state: State<'_, AppState>, path: PathBuf, file: HttpFile) -> CmdResult<HttpFile> {
    let path = state.confine_write(&path)?;
    let text = httpdesk_core::try_serialize(&file).map_err(err)?;
    state.write_file(&path, &text)?;
    Ok(httpdesk_core::parse(&text))
}

#[tauri::command]
fn render_request(request: Request) -> String {
    httpdesk_core::render_request(&Request { leading: String::new(), ..request })
}

#[tauri::command]
fn create_file(state: State<'_, AppState>, path: PathBuf, content: String) -> CmdResult<()> {
    let path = state.confine_write(&path)?;
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    state.write_file(&path, &content)
}

#[tauri::command]
fn create_dir(state: State<'_, AppState>, path: PathBuf) -> CmdResult<()> {
    let path = state.confine_entry(&path)?;
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    state.self_writes.creating_dir(&path);
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn rename_path(state: State<'_, AppState>, from: PathBuf, to: PathBuf) -> CmdResult<()> {
    let (from, to) = (state.confine_entry(&from)?, state.confine_entry(&to)?);
    if to.exists() && !confine::is_case_only_rename(&from, &to) {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    state.self_writes.moving(&from, &to);
    std::fs::rename(&from, &to).map_err(|e| format!("Could not move {}: {e}", from.display()))
}

/// Moves a file or folder to the OS trash. Never unlinks: if the trash is
/// unavailable it says so, and the UI asks before calling `delete_permanently`.
#[tauri::command]
async fn delete_path<R: tauri::Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<DeleteOutcome> {
    off_main(app, move |state| {
        let path = state.confine_entry(&path)?;
        state.self_writes.removing(&path);
        deleting::to_trash(&*state.trash.get(), &path)
    })
    .await
}

/// Unlinks a file or folder. Only called after the user confirms it.
#[tauri::command]
async fn delete_permanently<R: tauri::Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<()> {
    off_main(app, move |state| {
        let path = state.confine_entry(&path)?;
        state.self_writes.removing(&path);
        deleting::delete_permanently(&path)
    })
    .await
}

#[tauri::command]
fn path_exists(path: PathBuf) -> bool {
    path.exists()
}

// ------------------------------------------------------------------ environments

/// The workspace folder `dir` names (relative to the root, `/`-separated; the root when
/// missing or empty), confined to the workspace.
fn env_folder(state: &AppState, dir: Option<&str>) -> CmdResult<PathBuf> {
    let root = state.root()?;
    let Some(dir) = dir.filter(|d| !d.is_empty()) else { return Ok(root) };
    let path = state.confine(&dir.split('/').collect::<PathBuf>())?;
    if !path.is_dir() {
        return Err(format!("{dir} is not a folder of the workspace"));
    }
    Ok(path)
}

/// The environments in folder `dir`'s own pair of files (the root's by default): what
/// the Environments modal edits.
#[tauri::command]
fn load_environments(state: State<'_, AppState>, dir: Option<String>) -> CmdResult<EnvironmentSet> {
    env::load(&env_folder(&state, dir.as_deref())?).map_err(err)
}

/// The environments of the requests in each folder below the root that has env files
/// (ADR-0004); a request uses its nearest folder's, or the root's (`load_environments`).
#[tauri::command]
async fn load_folder_environments<R: tauri::Runtime>(app: AppHandle<R>) -> CmdResult<Vec<env::FolderEnvironments>> {
    off_main(app, |state| env::load_folders(&state.root()?).map_err(err)).await
}

/// Saves `set` as folder `dir`'s own pair of files (the root's by default).
#[tauri::command]
fn save_environments(state: State<'_, AppState>, set: EnvironmentSet, dir: Option<String>) -> CmdResult<SaveReport> {
    let root = state.root()?;
    let folder = env_folder(&state, dir.as_deref())?;
    // The core serializes, so the bytes are only known afterwards: mark both env files after saving.
    let report = env::save_folder(&root, &folder, &set).map_err(err)?;
    for name in [env::ENV_FILE, env::PRIVATE_ENV_FILE] {
        state.self_writes.wrote(&folder.join(name));
    }
    Ok(report)
}

// ------------------------------------------------------------------ execution

/// Payload of the `send-progress` event: body bytes received so far on the
/// wire for an in-flight send. Emitted at most ~10 times a second (see
/// `exec::PROGRESS_INTERVAL`) and never after the send returns.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendProgress {
    run_id: String,
    received: usize,
}

/// What a request is sent with: the variables (its folder's environment from disk,
/// then File variables, then its own, then its answered Prompt variables), the folder
/// its relative paths start from, and a warning when its folder doesn't define the
/// selected environment (it's then sent with none: ADR-0004).
/// Shared by send and preview so the two can't disagree.
struct RequestScope {
    resolver: Resolver,
    base_dir: PathBuf,
    env_warning: Option<String>,
}

fn request_resolver(
    root: Option<&Path>,
    request: &Request,
    file_path: Option<&Path>,
    file_variables: &[Variable],
    environment: Option<&str>,
    prompt_values: &HashMap<String, String>,
) -> Result<RequestScope, ExecError> {
    let base_dir = file_path
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| root.map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let env_set = match root {
        Some(r) => env::load_for(r, &base_dir).map_err(|e| ExecError::Other(e.to_string()))?,
        None => EnvironmentSet::default(),
    };
    let env_warning = match (root, environment) {
        (Some(r), Some(name)) if !env_set.environments.iter().any(|e| e.name == name) => Some(format!(
            "Environment \"{name}\" isn't defined for {}, so it's sent with no environment",
            folder_label(r, &base_dir)
        )),
        _ => None,
    };
    let env_vars = env::variables(&env_set, environment);
    // A File variable of a Secret's name replaces it, so it's no Secret.
    let secrets = env::secret_names(&env_set, environment)
        .into_iter()
        .filter(|n| !file_variables.iter().chain(&request.variables).any(|v| &v.name == n));
    let resolver = Resolver::for_request(&env_vars, file_variables, &request.variables, Some(&base_dir))
        .with_secrets(secrets)
        .with_prompts(&request.prompts(), prompt_values);
    Ok(RequestScope { resolver, base_dir, env_warning })
}

/// A folder as the UI names it: relative to the workspace root with a trailing `/`
/// (`api/users/`), or "the workspace root".
fn folder_label(root: &Path, dir: &Path) -> String {
    match env::relative_dir(root, dir) {
        rel if rel.is_empty() => "the workspace root".into(),
        rel => format!("{rel}/"),
    }
}

/// The resolved preview: what `send_request` would send, without sending it (see
/// `exec::preview`). Off the main thread, since it reads the environment files.
#[tauri::command]
async fn preview_request<R: tauri::Runtime>(
    app: AppHandle<R>,
    request: Request,
    file_path: Option<PathBuf>,
    file_variables: Vec<Variable>,
    environment: Option<String>,
    prompt_values: Option<HashMap<String, String>>,
) -> CmdResult<exec::RequestPreview> {
    off_main(app, move |state| {
        let root = state.root.lock().unwrap().clone();
        let scope = request_resolver(
            root.as_deref(),
            &request,
            file_path.as_deref(),
            &file_variables,
            environment.as_deref(),
            &prompt_values.unwrap_or_default(),
        )
        .map_err(err)?;
        let mut preview = exec::preview(&request, scope.resolver);
        preview.warnings.splice(0..0, scope.env_warning);
        Ok(preview)
    })
    .await
}

/// Unlike other commands, a failed send is a classified `{ kind, message, details }`
/// object (see `ExecError`), so the viewer can explain it and offer the fix.
// Each argument is a field of the IPC call (`RequestArgs` in src/lib/api.ts).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn send_request<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    run_id: String,
    request: Request,
    file_path: Option<PathBuf>,
    file_variables: Vec<Variable>,
    environment: Option<String>,
    prompt_values: Option<HashMap<String, String>>,
) -> Result<HttpResponse, ExecError> {
    let root = state.root.lock().unwrap().clone();
    let settings = state.settings.lock().unwrap().exec.clone();

    let (prepared, ssl) = {
        let scope = request_resolver(
            root.as_deref(),
            &request,
            file_path.as_deref(),
            &file_variables,
            environment.as_deref(),
            &prompt_values.unwrap_or_default(),
        )?;
        let mut prepared = exec::prepare(&request, &scope.resolver, &scope.base_dir, &settings)?;
        prepared.warnings.splice(0..0, scope.env_warning);
        let ssl = match (&root, &environment) {
            (Some(r), Some(e)) => env::ssl_config(r, &scope.base_dir, e),
            _ => Default::default(),
        };
        (prepared, ssl)
    };

    let progress_id = run_id.clone();
    let on_progress = move |received| {
        let _ = app.emit("send-progress", SendProgress { run_id: progress_id.clone(), received });
    };
    // Each send gets a client no other send is using (see ClientPool).
    let client = state.clients.checkout(&prepared, &settings, &ssl)?;
    let task = tokio::spawn(async move { exec::execute_on(&client, prepared, &settings, on_progress).await });
    state.running.lock().unwrap().insert(run_id.clone(), task.abort_handle());
    let result = task.await;
    state.running.lock().unwrap().remove(&run_id);

    match result {
        Ok(Ok(outcome)) => {
            let response = outcome.response;
            state.bodies.lock().unwrap().push(response.id.clone(), outcome.body, response.content_type.clone());
            Ok(with_pretty_text(response).await)
        }
        Ok(Err(e)) => Err(e),
        Err(e) if e.is_cancelled() => Err(ExecError::Other("Request cancelled".into())),
        Err(e) => Err(ExecError::Other(e.to_string())),
    }
}

#[tauri::command]
fn cancel_request(state: State<'_, AppState>, run_id: String) {
    if let Some(handle) = state.running.lock().unwrap().remove(&run_id) {
        handle.abort();
    }
}

/// The error for a response id whose body has been evicted (or never stored).
const RESPONSE_GONE: &str = "Response is no longer available";

/// The stored body of `response_id`, or [`RESPONSE_GONE`].
fn stored_body(state: &AppState, response_id: &str) -> CmdResult<Arc<[u8]>> {
    state.bodies.lock().unwrap().get(response_id).ok_or_else(|| RESPONSE_GONE.to_string())
}

/// The stored body of `response_id` with its content type, or [`RESPONSE_GONE`].
fn stored_body_with_type(state: &AppState, response_id: &str) -> CmdResult<(Arc<[u8]>, Option<String>)> {
    state.bodies.lock().unwrap().get_with_type(response_id).ok_or_else(|| RESPONSE_GONE.to_string())
}

#[tauri::command]
async fn save_response_body<R: tauri::Runtime>(app: AppHandle<R>, response_id: String, path: PathBuf) -> CmdResult<()> {
    off_main(app, move |state| {
        let body = stored_body(state, &response_id)?;
        std::fs::write(&path, body).map_err(err)
    })
    .await
}

/// Beautify and Minify: re-lays out a request body without changing any token
/// (`body_format`). On the blocking pool, since bodies can be large.
#[tauri::command]
async fn format_body(text: String, kind: BodyKind, mode: FormatMode) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || body_format::format_body(&text, kind, mode).map_err(err))
        .await
        .map_err(err)?
}

/// The Hex view of a binary response: a dump of the start of the stored body
/// (`body_format::hexdump`), so it works even for bodies too big to send to
/// the UI as base64.
#[tauri::command]
async fn hexdump<R: tauri::Runtime>(app: AppHandle<R>, response_id: String) -> CmdResult<String> {
    off_main(app, move |state| {
        let body = stored_body(state, &response_id)?;
        Ok(body_format::hexdump(&body))
    })
    .await
}

/// The stored body of `response_id` parsed as JSON, parsed on first use and
/// then kept (see `json_docs`). The lock isn't held while parsing, so a large
/// body doesn't hold up queries on other responses.
fn json_doc(state: &AppState, response_id: &str) -> CmdResult<Arc<JsonDocument>> {
    if let Some(parsed) = state.json_docs.lock().unwrap().get(response_id) {
        return parsed;
    }
    let (body, content_type) = stored_body_with_type(state, response_id)?;
    // Decoded the way the response's `bodyText` was (its charset, else UTF-8).
    let text = exec::decode_text(&body, content_type.as_deref()).ok_or("The body isn't text")?;
    let parsed = JsonDocument::parse(&text).map(Arc::new).map_err(err);
    state.json_docs.lock().unwrap().insert(response_id.to_owned(), parsed.clone());
    parsed
}

/// The filter bar: evaluates a JSONPath expression against a stored response
/// body, returning the match count and the matches as lossless pretty JSON.
#[tauri::command]
async fn filter_response<R: tauri::Runtime>(
    app: AppHandle<R>,
    response_id: String,
    expression: String,
) -> CmdResult<FilterResult> {
    off_main(app, move |state| json_doc(state, &response_id)?.filter(&expression).map_err(err)).await
}

/// Text bodies up to this size arrive with their Pretty text, so Pretty view
/// shows at once. Larger ones are formatted only when Pretty is opened
/// (`pretty_response`), so a big body isn't formatted, nor sent twice, unasked.
const PRETTY_INLINE_BYTES: usize = 1024 * 1024;

/// Fills in `pretty_text` for a small JSON or XML response (its raw text if it
/// doesn't parse, which is what Pretty view shows then), on the blocking pool.
async fn with_pretty_text(mut response: HttpResponse) -> HttpResponse {
    let Some(text) = response.body_text.clone().filter(|t| t.len() <= PRETTY_INLINE_BYTES) else {
        return response;
    };
    let content_type = response.content_type.clone();
    let pretty = tauri::async_runtime::spawn_blocking(move || {
        let pretty = body_format::pretty_response(content_type.as_deref(), &text);
        pretty.map(|r| r.unwrap_or(text))
    });
    // If formatting failed outright, the viewer asks for it again when needed.
    response.pretty_text = pretty.await.ok().flatten();
    response
}

/// The response Pretty view of a stored body, for bodies too large to arrive
/// with their Pretty text. Rejects when the body isn't JSON or XML, doesn't
/// parse, or has been evicted; the viewer shows the raw body then.
#[tauri::command]
async fn pretty_response<R: tauri::Runtime>(app: AppHandle<R>, response_id: String) -> CmdResult<String> {
    off_main(app, move |state| {
        let (body, content_type) = stored_body_with_type(state, &response_id)?;
        let text = exec::decode_text(&body, content_type.as_deref()).ok_or("Response body isn't text")?;
        body_format::pretty_response(content_type.as_deref(), &text)
            .ok_or("Response body isn't JSON or XML")?
            .map_err(err)
    })
    .await
}

/// Key completion for the filter bar: the keys reachable at each place in a
/// stored JSON response body. Built once per parsed document and kept with it,
/// so the frontend fetches it once per response and completes locally.
#[tauri::command]
async fn response_shape<R: tauri::Runtime>(app: AppHandle<R>, response_id: String) -> CmdResult<Shape> {
    off_main(app, move |state| Ok(json_doc(state, &response_id)?.shape().clone())).await
}

// ------------------------------------------------------------------ settings

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> CmdResult<()> {
    // Applied either way: the UI already shows the new values for this session.
    let saved = persist_settings(&app, &settings);
    *state.settings.lock().unwrap() = settings;
    saved
}

#[tauri::command]
fn set_unsaved(state: State<'_, AppState>, unsaved: bool) {
    state.unsaved.store(unsaved, Ordering::Relaxed);
}

// ------------------------------------------------------------------ OpenAPI

fn is_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

#[tauri::command]
async fn openapi_load(state: State<'_, AppState>, source: String) -> CmdResult<SpecSummary> {
    let source = source.trim().to_string();
    let doc = if is_url(&source) {
        OpenApiDoc::load_url(&source).await.map_err(err)?
    } else {
        let path = PathBuf::from(&source);
        tokio::task::spawn_blocking(move || OpenApiDoc::load_file(&path)).await.map_err(err)?.map_err(err)?
    };
    let summary = doc.summary();
    state.specs.lock().unwrap().insert(source, doc);
    Ok(summary)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateReport {
    /// Files that would be / were written.
    files: Vec<PathBuf>,
    /// Target files that already exist.
    conflicts: Vec<PathBuf>,
    written: bool,
    environments: Vec<String>,
    env_dir: PathBuf,
    gitignore_updated: bool,
    warnings: Vec<String>,
}

#[tauri::command]
async fn openapi_generate<R: tauri::Runtime>(
    app: AppHandle<R>,
    source: String,
    options: GenerateOptions,
    output_dir: PathBuf,
    overwrite: bool,
    dry_run: bool,
) -> CmdResult<GenerateReport> {
    let request = GenerateRequest { source, options, output_dir, overwrite, dry_run };
    off_main(app, move |state| openapi_generate_blocking(state, &request)).await
}

/// The arguments of `openapi_generate`.
struct GenerateRequest {
    /// The loaded specification (as passed to `openapi_load`).
    source: String,
    options: GenerateOptions,
    output_dir: PathBuf,
    /// Replace files that already exist; otherwise they are only reported.
    overwrite: bool,
    /// Report what would be written without writing anything.
    dry_run: bool,
}

fn openapi_generate_blocking(state: &AppState, request: &GenerateRequest) -> CmdResult<GenerateReport> {
    let GenerateRequest { source, options, output_dir, overwrite, dry_run } = request;
    let (overwrite, dry_run) = (*overwrite, *dry_run);
    let output = {
        let specs = state.specs.lock().unwrap();
        let doc = specs.get(source.trim()).ok_or("Load the specification first")?;
        doc.generate(options)
    };
    let output_dir = state.confine(output_dir)?;
    let files = output
        .files
        .iter()
        .map(|f| state.confine_write(&output_dir.join(&f.relative_path)))
        .collect::<CmdResult<Vec<_>>>()?;
    let conflicts: Vec<PathBuf> = files.iter().filter(|p| p.exists()).cloned().collect();
    // Output is confined to the workspace, so environments always go to its root.
    let env_dir = state.root()?;
    let mut report = GenerateReport {
        files,
        conflicts,
        written: false,
        environments: output.environments.iter().map(|e| e.name.clone()).collect(),
        env_dir: env_dir.clone(),
        gitignore_updated: false,
        warnings: output.warnings.clone(),
    };
    if dry_run || (!overwrite && !report.conflicts.is_empty()) {
        return Ok(report);
    }

    // Serialize everything first so a refused file leaves nothing half-written.
    let texts = output
        .files
        .iter()
        .map(|g| httpdesk_core::try_serialize(&g.file).map_err(err))
        .collect::<CmdResult<Vec<_>>>()?;
    std::fs::create_dir_all(&output_dir).map_err(err)?;
    for (text, path) in texts.iter().zip(&report.files) {
        state.write_file(path, text)?;
    }
    for e in &output.environments {
        env::merge_variables(&env_dir, &e.name, &e.variables, false).map_err(err)?;
        if !e.secrets.is_empty() {
            let r = env::merge_variables(&env_dir, &e.name, &e.secrets, true).map_err(err)?;
            report.gitignore_updated |= r.gitignore_updated;
        }
    }
    report.written = true;
    Ok(report)
}

// ------------------------------------------------------------------ entry point

/// Reads settings.json into the app state (keeping the defaults if it's missing or unreadable).
fn load_settings<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(text) = settings_path(app).and_then(|p| std::fs::read_to_string(p).ok()) {
        if let Ok(mut s) = serde_json::from_str::<AppSettings>(&text) {
            s.recent_workspaces = simplified_recents(&s.recent_workspaces);
            *app.state::<AppState>().settings.lock().unwrap() = s;
        }
    }
}

/// Runs at setup once settings are loaded.
type AfterSetup<R> = fn(&tauri::App<R>) -> tauri::Result<()>;

/// Registers state and commands and loads settings at setup, then runs
/// `after_setup` (shared by the app and the IPC tests).
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>, after_setup: AfterSetup<R>) -> tauri::Builder<R> {
    builder
        .manage(AppState::default())
        .setup(move |app| {
            load_settings(app.handle());
            Ok(after_setup(app)?)
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            get_tree,
            search_requests,
            find_usages,
            read_http_file,
            save_http_file,
            render_request,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            delete_permanently,
            path_exists,
            load_environments,
            load_folder_environments,
            save_environments,
            send_request,
            preview_request,
            cancel_request,
            save_response_body,
            format_body,
            hexdump,
            filter_response,
            pretty_response,
            response_shape,
            get_settings,
            save_settings,
            set_unsaved,
            openapi_load,
            openapi_generate,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init()),
        theme::create_main_window,
    )
    .build(tauri::generate_context!())
    .expect("error while building HttpDesk")
    .run(|_app, _event| {
        // After setup, on the main thread, with tao's app delegate in place.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Ready = _event {
            quit::install(_app);
        }
    });
}

#[cfg(test)]
mod ipc_tests;
