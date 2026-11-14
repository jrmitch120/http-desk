//! Tauri shell: thin commands over `httpdesk-core`, plus the workspace file
//! watcher. All domain logic lives in the core crate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use httpdesk_core::body_format::{self, BodyKind, FormatMode};
use httpdesk_core::cookies::StoredCookie;
use httpdesk_core::env::{self, EnvironmentSet, SaveReport};
use httpdesk_core::exchange;
use httpdesk_core::exec::{self, ExecError, ExecSettings, HttpResponse};
use httpdesk_core::json_filter::{FilterResult, JsonDocument, Shape};
use httpdesk_core::openapi::{GenerateOptions, OpenApiDoc, SpecSummary};
use httpdesk_core::script;
use httpdesk_core::session::Session;
use httpdesk_core::vars::Resolver;
use httpdesk_core::workspace::{self, SearchHit, TreeNode, Usage};
use httpdesk_core::{HttpFile, Request, Variable};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

mod bodies;
mod confine;
mod copying;
mod deleting;
mod json_docs;
mod menu;
mod paths;
mod quit;
mod self_writes;
mod theme;
mod watcher;
mod window_state;
use bodies::{KeptBodies, KeptBody};
use copying::Clipboard;
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
    /// The sidebar is hidden (View → Show Sidebar). Its width is kept meanwhile.
    #[serde(deserialize_with = "or_default")]
    sidebar_hidden: bool,
    /// The zoom of the whole interface, `1.0` being 100% (View → Zoom In / Zoom Out / Actual Size).
    /// Applied before the first paint (theme.rs). Out of range, or not a number: 100%.
    #[serde(deserialize_with = "zoom_or_default")]
    zoom: f64,
    /// The request pane's share of the request/response split, per layout.
    split_ratio: SplitRatio,
    /// Height in px of the panel area below the requests (the Session panel).
    #[serde(deserialize_with = "or_default")]
    panel_height: f64,
    /// Show the resolved preview under the URL bar.
    show_resolved: bool,
    /// How the Environments modal shows variables.
    #[serde(deserialize_with = "or_default")]
    env_view: EnvView,
    /// Per workspace: the Environments matrix's column widths, as the user resized them.
    #[serde(deserialize_with = "or_default")]
    env_matrix_widths: HashMap<String, MatrixWidths>,
    /// Trusted workspaces, by canonical root path: the only ones whose scripts run.
    /// Only the shell changes this (`trust_workspace`, `revoke_workspace_trust`):
    /// `save_settings` keeps it as is, so a page saving an older copy can't undo either.
    #[serde(deserialize_with = "or_default")]
    trusted_workspaces: Vec<String>,
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
    /// One environment at a time.
    #[default]
    List,
    /// Every environment side by side.
    Matrix,
}

/// Reads a settings field, taking the default for a value this version doesn't know
/// (a hand-edited file, or a newer version's), so one odd field doesn't drop the rest.
fn or_default<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// The zoom range, the lowest and highest of the frontend's levels (`ZOOM_LEVELS`
/// in src/lib/zoom.ts; src/lib/zoom.test.ts checks they agree).
const MIN_ZOOM: f64 = 0.5;
const MAX_ZOOM: f64 = 1.5;

/// Reads `zoom`, taking 100% for anything but a number in the zoom range, as the
/// frontend's `zoomOf` does. A value between two levels is kept as written.
fn zoom_or_default<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let zoom = serde_json::Value::deserialize(d)?.as_f64().unwrap_or(1.0);
    Ok(if (MIN_ZOOM..=MAX_ZOOM).contains(&zoom) { zoom } else { 1.0 })
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

/// Defaults must match `SIDEBAR`/`SPLIT`/`PANEL` in src/lib/panes.ts (src/lib/panes.test.ts checks).
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
            sidebar_hidden: false,
            zoom: 1.0,
            split_ratio: SplitRatio::default(),
            panel_height: 260.0,
            show_resolved: false,
            env_view: EnvView::List,
            env_matrix_widths: HashMap::new(),
            trusted_workspaces: Vec::new(),
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
    /// Where Copy body writes (the OS clipboard; tests replace it).
    clipboard: Clipboard,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Idle HTTP clients, so a send can reuse a connection an earlier one left open.
    clients: exec::ClientPool,
    /// The open workspace's Session, in memory only. Opening a workspace replaces it.
    session: Mutex<Arc<Session>>,
    /// Response bodies by response id, kept until released (see bodies.rs).
    bodies: Mutex<KeptBodies>,
    /// Recent bodies parsed as JSON, by response id (for the filter bar).
    json_docs: Mutex<JsonDocs>,
    specs: Mutex<HashMap<String, OpenApiDoc>>,
    settings: Mutex<AppSettings>,
    /// Whether an open file has unsaved edits (reported by the frontend), so a
    /// logout asks first. See quit.rs.
    unsaved: AtomicBool,
    /// How long to wait between recording an env file and writing it, so tests can make
    /// writing outlast the watcher's debounce.
    #[cfg(test)]
    env_write_delay: Mutex<std::time::Duration>,
}

impl AppState {
    fn root(&self) -> CmdResult<PathBuf> {
        self.root.lock().unwrap().clone().ok_or_else(|| "No workspace is open".to_string())
    }

    /// The open workspace's Session. A send keeps the one it started with, so it can't
    /// reach the next workspace's Session if that opens while it's in flight.
    fn session(&self) -> Arc<Session> {
        self.session.lock().unwrap().clone()
    }

    fn write_file(&self, path: &Path, text: &str) -> CmdResult<()> {
        self.self_writes.writing(path, text.as_bytes());
        workspace::write_atomic(path, text.as_bytes()).map_err(|e| format!("Could not write {}: {e}", path.display()))
    }

    /// The hook `env` saves call before writing each env file: records the file's exact
    /// bytes, so the watcher never reports the write, however long it takes.
    fn recording_env_writes(&self) -> impl FnMut(&Path, &[u8]) + '_ {
        move |path, bytes| {
            self.self_writes.writing(path, bytes);
            #[cfg(test)]
            {
                let delay = *self.env_write_delay.lock().unwrap();
                std::thread::sleep(delay);
            }
        }
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
    let dir = config_dir_override().or_else(|| app.path().app_config_dir().ok())?;
    Some(dir.join("settings.json"))
}

/// The config folder `HTTPDESK_CONFIG_DIR` sets, if any.
fn config_dir_override() -> Option<PathBuf> {
    std::env::var_os("HTTPDESK_CONFIG_DIR").map(PathBuf::from)
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
    // A new workspace starts with nothing remembered from the last one.
    *state.session.lock().unwrap() = Arc::default();
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
    env::save_folder(&root, &folder, &set, state.recording_env_writes()).map_err(err)
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
/// then File variables, then its own, then the Prompt variable answers the Session
/// holds for `request_key`), the Request variables of its file's named requests
/// (`request_names`, read from their latest exchanges in the Session), the folder its
/// relative paths start from, and a warning
/// when its folder doesn't define the selected environment (it's then sent with
/// none: ADR-0004).
/// Shared by send and preview so the two can't disagree.
struct RequestScope {
    resolver: Resolver,
    base_dir: PathBuf,
    env_warning: Option<String>,
    /// The environment's variables, private ones included: what a pre-request
    /// script's `request.environment.get` reads.
    environment: HashMap<String, String>,
}

// One argument per input of the scope, as the IPC calls give them (`RequestArgs`).
#[allow(clippy::too_many_arguments)]
fn request_resolver(
    root: Option<&Path>,
    request: &Request,
    file_path: Option<&Path>,
    file_variables: &[Variable],
    environment: Option<&str>,
    session: &Session,
    request_key: Option<&str>,
    request_names: &[String],
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
        .with_prompts(&request.prompts(), &request_key.map(|k| session.prompt_answers().get(k)).unwrap_or_default())
        .with_request_variables(match file_path {
            Some(file) => session.exchanges().for_file(file, request_names),
            // Unsaved nowhere: its named requests have no exchanges.
            None => request_names.iter().map(|n| (n.clone(), None)).collect(),
        });
    Ok(RequestScope { resolver, base_dir, env_warning, environment: env_vars })
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
    request_key: Option<String>,
    request_names: Option<Vec<String>>,
) -> CmdResult<exec::RequestPreview> {
    off_main(app, move |state| {
        let root = state.root.lock().unwrap().clone();
        let scope = request_resolver(
            root.as_deref(),
            &request,
            file_path.as_deref(),
            &file_variables,
            environment.as_deref(),
            &state.session(),
            request_key.as_deref(),
            &request_names.unwrap_or_default(),
        )
        .map_err(err)?;
        let mut preview = exec::preview(&request, scope.resolver);
        preview.warnings.splice(0..0, scope.env_warning);
        Ok(preview)
    })
    .await
}

/// The warning on a response whose request has scripts that were skipped, naming them.
fn scripts_skipped(request: &Request) -> String {
    let pre = !request.pre_request_parts().is_empty();
    let handler = request.response_handler_parts().iter().any(|p| p.is_script());
    let skipped = match (pre, handler) {
        (true, true) => "the pre-request script and the response handler",
        (true, false) => "the pre-request script",
        _ => "the response handler",
    };
    format!("Sent without scripts: {skipped} didn't run.")
}

/// Runs the request's pre-request script, if it has one, off the async workers
/// (it may take up to the script time limit).
async fn run_pre_request(
    request: &Request,
    environment: &HashMap<String, String>,
) -> Result<script::PreRequestResults, ExecError> {
    if request.pre_request_parts().is_empty() {
        return Ok(Default::default());
    }
    let (request, environment) = (request.clone(), environment.clone());
    tokio::task::spawn_blocking(move || script::run_pre_request_script(&request, &environment))
        .await
        .map_err(|e| ExecError::Other(e.to_string()))?
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
    request_key: Option<String>,
    request_names: Option<Vec<String>>,
    skip_scripts: Option<bool>,
) -> Result<HttpResponse, ExecError> {
    let root = state.root.lock().unwrap().clone();
    let (settings, trusted) = {
        let s = state.settings.lock().unwrap();
        let trusted = root.as_ref().is_some_and(|r| s.trusted_workspaces.contains(&r.to_string_lossy().into_owned()));
        (s.exec.clone(), trusted)
    };
    let session = state.session();
    let has_scripts = script::has_scripts(&request);
    let run_scripts = has_scripts && !skip_scripts.unwrap_or(false);
    if run_scripts && !trusted {
        return Err(ExecError::UntrustedWorkspace);
    }

    let (prepared, ssl, pre) = {
        let scope = request_resolver(
            root.as_deref(),
            &request,
            file_path.as_deref(),
            &file_variables,
            environment.as_deref(),
            &session,
            request_key.as_deref(),
            &request_names.unwrap_or_default(),
        )?;
        // JetBrains order: the pre-request script runs before variables are substituted.
        let pre = if run_scripts { run_pre_request(&request, &scope.environment).await? } else { Default::default() };
        let resolver = scope.resolver.with_pre_request_variables(&pre.variables);
        let mut prepared = exec::prepare(&request, &resolver, &scope.base_dir, &settings)?;
        prepared.warnings.splice(0..0, scope.env_warning);
        if has_scripts && !run_scripts {
            prepared.warnings.push(scripts_skipped(&request));
        }
        let ssl = match (&root, &environment) {
            (Some(r), Some(e)) => env::ssl_config(r, &scope.base_dir, e),
            _ => Default::default(),
        };
        (prepared, ssl, pre.results)
    };

    // A `# @name` request's exchange becomes its latest, in the Session the send started in.
    let pending = exchange::begin(file_path.as_deref(), &request, &prepared);
    let progress_id = run_id.clone();
    let on_progress = move |received| {
        let _ = app.emit("send-progress", SendProgress { run_id: progress_id.clone(), received });
    };
    // Each send gets a client no other send is using (see ClientPool), and uses the
    // cookie jar of the Session it started in.
    let client = state.clients.checkout(&prepared, &settings, &ssl)?;
    let jar = session.cookies().clone();
    let task = tokio::spawn(async move {
        let mut outcome = exec::execute_on(&client, prepared, &settings, Some(&jar), on_progress).await?;
        if run_scripts {
            // Up to the script time limit of CPU work: off the async workers.
            let handled = tokio::task::spawn_blocking(move || {
                let results = script::run_response_handler(&request, &outcome.response, &outcome.body);
                // The pre-request script's tests and logs come first.
                outcome.response.tests = pre.tests.into_iter().chain(results.tests).collect();
                outcome.response.logs = pre.logs.into_iter().chain(results.logs).collect();
                outcome
            });
            outcome = handled.await.map_err(|e| ExecError::Other(e.to_string()))?;
        }
        Ok(outcome)
    });
    state.running.lock().unwrap().insert(run_id.clone(), task.abort_handle());
    let result = task.await;
    state.running.lock().unwrap().remove(&run_id);

    match result {
        Ok(Ok(outcome)) => {
            let response = outcome.response;
            let (id, content_type) = (response.id.clone(), response.content_type.clone());
            let bytes: Arc<[u8]> = outcome.body.into();
            if let Some(pending) = pending {
                pending.finish(session.exchanges(), &response, bytes.clone());
            }
            let body = KeptBody { bytes, content_type, kind: response.body_kind };
            state.bodies.lock().unwrap().push(id, body);
            Ok(response)
        }
        Ok(Err(e)) => Err(e),
        Err(e) if e.is_cancelled() => Err(ExecError::Other("Request cancelled".into())),
        Err(e) => Err(ExecError::Other(e.to_string())),
    }
}

/// The Prompt variable answers the Session holds for a request, by name. The
/// request key is the webview's key for the request (`_key`).
#[tauri::command]
fn prompt_answers(state: State<'_, AppState>, request_key: String) -> HashMap<String, String> {
    state.session().prompt_answers().get(&request_key)
}

/// Remembers answers to a request's Prompt variables in the Session, alongside any it
/// already holds, for its next sends. Kept in memory only.
#[tauri::command]
fn answer_prompts(state: State<'_, AppState>, request_key: String, answers: HashMap<String, String>) {
    state.session().prompt_answers().answer(&request_key, answers);
}

/// Forgets a request's Prompt variable answers, so its next send asks again.
#[tauri::command]
fn forget_prompt_answers(state: State<'_, AppState>, request_key: String) {
    state.session().prompt_answers().forget(&request_key);
}

/// The shape of the latest exchange of the request named `name` in `file_path`, in the
/// Session: its status, when it arrived, and each side's header names and JSON keys,
/// which its Request variables' paths complete from. Null when it hasn't been sent.
/// Off the main thread, since it parses the bodies.
#[tauri::command]
async fn exchange_shape<R: tauri::Runtime>(
    app: AppHandle<R>,
    file_path: PathBuf,
    name: String,
) -> CmdResult<Option<exchange::ExchangeShape>> {
    off_main(app, move |state| Ok(state.session().exchanges().latest(&file_path, &name).map(|e| e.shape()))).await
}

/// The cookies in the Session's jar, for the Session panel: unexpired ones, by
/// domain, then path, then name.
#[tauri::command]
fn session_cookies(state: State<'_, AppState>) -> Vec<StoredCookie> {
    state.session().cookies().list()
}

/// Deletes one cookie from the Session's jar, so later sends don't carry it.
/// False if there was no such cookie.
#[tauri::command]
fn delete_cookie(state: State<'_, AppState>, domain: String, path: String, name: String) -> bool {
    state.session().cookies().remove(&domain, &path, &name)
}

/// Deletes every cookie in the Session's jar.
#[tauri::command]
fn clear_cookies(state: State<'_, AppState>) {
    state.session().cookies().clear();
}

/// Empties the whole Session (Clear session): every section, cookies and prompt
/// answers included.
#[tauri::command]
fn clear_session(state: State<'_, AppState>) {
    state.session().clear();
}

#[tauri::command]
fn cancel_request(state: State<'_, AppState>, run_id: String) {
    if let Some(handle) = state.running.lock().unwrap().remove(&run_id) {
        handle.abort();
    }
}

/// The error for a response id whose body has been released (or never stored).
const RESPONSE_GONE: &str = "Response is no longer available";

/// Drops response `response_id`'s body and everything cached from it (its parsed
/// JSON and key completion). The webview calls it once no tab shows the response:
/// its tab closed, got a newer response, or closed with the workspace.
#[tauri::command]
fn release_response(state: State<'_, AppState>, response_id: String) {
    drop_kept(&state, Some(&response_id));
}

/// A page load (including a reload): no tab can still refer to a kept body, so
/// they all go, with everything cached from them.
fn page_loaded(state: &AppState) {
    drop_kept(state, None);
}

/// Drops response `response_id`'s kept body, or every kept body (`None`), with
/// everything cached from them (parsed JSON and key completion).
fn drop_kept(state: &AppState, response_id: Option<&str>) {
    // Bodies before parsed documents, the order `json_doc` locks them in.
    let mut bodies = state.bodies.lock().unwrap();
    let mut json_docs = state.json_docs.lock().unwrap();
    match response_id {
        Some(id) => {
            bodies.remove(id);
            json_docs.remove(id);
        }
        None => {
            bodies.clear();
            json_docs.clear();
        }
    }
}

/// The kept body of `response_id` (with its content type and kind), or [`RESPONSE_GONE`].
fn kept_body(state: &AppState, response_id: &str) -> CmdResult<KeptBody> {
    state.bodies.lock().unwrap().get(response_id).ok_or_else(|| RESPONSE_GONE.to_string())
}

#[tauri::command]
async fn save_response_body<R: tauri::Runtime>(app: AppHandle<R>, response_id: String, path: PathBuf) -> CmdResult<()> {
    off_main(app, move |state| {
        let body = kept_body(state, &response_id)?;
        std::fs::write(&path, &body.bytes).map_err(err)
    })
    .await
}

/// Copy body: puts the kept body of `response_id` on the clipboard, text as
/// text and binary as base64, on the blocking pool, so a body of any size is
/// copied without the webview holding it. Rejects when the body has been
/// released or the clipboard can't be written.
#[tauri::command]
async fn copy_response_body<R: tauri::Runtime>(app: AppHandle<R>, response_id: String) -> CmdResult<()> {
    let handle = app.clone();
    off_main(app, move |state| {
        let body = kept_body(state, &response_id)?;
        state.clipboard.write(&handle, body.clipboard_text())
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

/// The Hex view of a binary response: a dump of the start of the kept body
/// (`body_format::hexdump`), so it works even for bodies too big to send to
/// the UI as base64.
#[tauri::command]
async fn hexdump<R: tauri::Runtime>(app: AppHandle<R>, response_id: String) -> CmdResult<String> {
    off_main(app, move |state| {
        let body = kept_body(state, &response_id)?;
        Ok(body_format::hexdump(&body.bytes))
    })
    .await
}

/// The kept body of `response_id` parsed as JSON, parsed on first use and
/// then kept (see `json_docs`). The lock isn't held while parsing, so a large
/// body doesn't hold up queries on other responses.
fn json_doc(state: &AppState, response_id: &str) -> CmdResult<Arc<JsonDocument>> {
    if let Some(parsed) = state.json_docs.lock().unwrap().get(response_id) {
        return parsed;
    }
    // Decoded the way Raw shows it (its charset, else UTF-8).
    let text = kept_body(state, response_id)?.text().ok_or("The body isn't text")?;
    let parsed = JsonDocument::parse(&text).map(Arc::new).map_err(err);
    // Not kept if the body was released while parsing, or it would never go.
    let bodies = state.bodies.lock().unwrap();
    if bodies.contains(response_id) {
        state.json_docs.lock().unwrap().insert(response_id.to_owned(), parsed.clone());
    }
    parsed
}

/// The filter bar: evaluates a JSONPath expression against a kept response
/// body, returning the match count and the matches as lossless pretty JSON.
#[tauri::command]
async fn filter_response<R: tauri::Runtime>(
    app: AppHandle<R>,
    response_id: String,
    expression: String,
) -> CmdResult<FilterResult> {
    off_main(app, move |state| json_doc(state, &response_id)?.filter(&expression).map_err(err)).await
}

/// Which form of a kept body [`response_body`] sends.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BodyFetchView {
    /// The body as text, decoded from its declared charset.
    Raw,
    /// The Pretty view's text: the body as JSON or XML laid out by the lossless
    /// formatter, so numbers and strings stay exactly as the server sent them.
    Pretty,
    /// The body's bytes exactly as stored (after Content-Encoding is undone).
    Bytes,
}

/// A kept body for the viewer, by response id, as raw bytes (an
/// `ArrayBuffer` in the webview, not a JSON string): text as UTF-8. Decoding
/// and formatting run on the blocking pool. Rejects when the body has been
/// released, isn't text (its kind is binary), or (for Pretty) isn't JSON or
/// XML or doesn't parse, which reports "isn't JSON or XML" either way; the
/// viewer shows the raw text instead of a Pretty one it can't have.
#[tauri::command]
async fn response_body<R: tauri::Runtime>(
    app: AppHandle<R>,
    response_id: String,
    view: BodyFetchView,
) -> CmdResult<tauri::ipc::Response> {
    off_main(app, move |state| {
        let body = kept_body(state, &response_id)?;
        let text = || body.text().ok_or("Response body isn't text");
        let bytes = match view {
            BodyFetchView::Raw => text()?.into_bytes(),
            BodyFetchView::Pretty => body_format::pretty_response(body.content_type.as_deref(), &text()?)
                .and_then(Result::ok)
                .ok_or("Response body isn't JSON or XML")?
                .into_bytes(),
            BodyFetchView::Bytes => body.bytes.to_vec(),
        };
        Ok(tauri::ipc::Response::new(bytes))
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
    let mut current = state.settings.lock().unwrap();
    let settings = AppSettings { trusted_workspaces: current.trusted_workspaces.clone(), ..settings };
    // Applied either way: the UI already shows the new values for this session.
    let saved = persist_settings(&app, &settings);
    *current = settings;
    saved
}

/// Makes the open workspace a Trusted workspace, so its scripts run, and
/// returns every Trusted workspace. Stored in the app settings, never in the workspace.
#[tauri::command]
fn trust_workspace<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let root = state.root()?.to_string_lossy().into_owned();
    update_trust(&app, &state, |trusted| {
        if !trusted.contains(&root) {
            trusted.push(root);
        }
    })
}

/// Stops trusting the workspace at `path` (as `trustedWorkspaces` lists it) and
/// returns the Trusted workspaces left.
#[tauri::command]
fn revoke_workspace_trust<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<Vec<String>> {
    update_trust(&app, &state, |trusted| trusted.retain(|p| *p != path))
}

fn update_trust<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    change: impl FnOnce(&mut Vec<String>),
) -> CmdResult<Vec<String>> {
    let mut settings = state.settings.lock().unwrap();
    change(&mut settings.trusted_workspaces);
    persist_settings(app, &settings)?;
    Ok(settings.trusted_workspaces.clone())
}

#[tauri::command]
fn set_unsaved(state: State<'_, AppState>, unsaved: bool) {
    state.unsaved.store(unsaved, Ordering::Relaxed);
}

// ------------------------------------------------------------------ about

/// Which HttpDesk this is, for About HttpDesk and Report an Issue.
#[derive(Serialize)]
struct AppInfo {
    version: String,
    /// Rust's name for the OS: "macos", "windows", "linux".
    os: &'static str,
    /// Rust's name for the CPU architecture: "aarch64", "x86_64".
    arch: &'static str,
}

#[tauri::command]
fn app_info<R: tauri::Runtime>(app: AppHandle<R>) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), os: std::env::consts::OS, arch: std::env::consts::ARCH }
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
    if !output.environments.is_empty() {
        // Merged first and saved once, so each env file is written (and recorded) once.
        let mut set = env::load(&env_dir).map_err(err)?;
        for e in &output.environments {
            env::merge_variables(&mut set, &e.name, &e.variables, false);
            env::merge_variables(&mut set, &e.name, &e.secrets, true);
        }
        let saved = env::save_folder(&env_dir, &env_dir, &set, state.recording_env_writes()).map_err(err)?;
        report.gitignore_updated = saved.gitignore_updated;
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
        .manage(menu::NativeMenu::<R>::new())
        .on_menu_event(|app, event| menu::clicked(app, event.id().as_ref()))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                page_loaded(&webview.state::<AppState>());
            }
        })
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
            prompt_answers,
            answer_prompts,
            forget_prompt_answers,
            exchange_shape,
            session_cookies,
            delete_cookie,
            clear_cookies,
            clear_session,
            save_response_body,
            copy_response_body,
            release_response,
            format_body,
            hexdump,
            filter_response,
            response_body,
            response_shape,
            get_settings,
            save_settings,
            trust_workspace,
            revoke_workspace_trust,
            set_unsaved,
            app_info,
            openapi_load,
            openapi_generate,
            menu::set_menu,
            menu::set_menu_state,
        ])
}

/// For the shell's tests that can't run on libtest's threads (src-tauri/tests).
#[doc(hidden)]
pub mod test_support {
    /// The app's state and commands on `builder`, without a main window.
    pub fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
        super::with_commands(builder, |_| Ok(()))
    }

    /// What a click on native menu item `id` does.
    pub fn menu_clicked<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
        super::menu::clicked(app, id)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(window_state::plugin(config_dir_override())),
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
