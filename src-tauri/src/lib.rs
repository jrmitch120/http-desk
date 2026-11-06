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
use httpdesk_core::workspace::{self, SearchHit, TreeNode};
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
            theme: "system".into(),
            layout: "horizontal".into(),
            check_updates: true,
            show_descriptions: true,
            sidebar_width: 280.0,
            split_ratio: SplitRatio::default(),
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

#[tauri::command]
fn load_environments(state: State<'_, AppState>) -> CmdResult<EnvironmentSet> {
    env::load(&state.root()?).map_err(err)
}

#[tauri::command]
fn save_environments(state: State<'_, AppState>, set: EnvironmentSet) -> CmdResult<SaveReport> {
    let root = state.root()?;
    // The core serializes, so the bytes are only known afterwards: mark both env files after saving.
    let report = env::save(&root, &set).map_err(err)?;
    for name in [env::ENV_FILE, env::PRIVATE_ENV_FILE] {
        state.self_writes.wrote(&root.join(name));
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

/// Unlike other commands, a failed send is a classified `{ kind, message, details }`
/// object (see `ExecError`), so the viewer can explain it and offer the fix.
#[tauri::command]
async fn send_request<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    run_id: String,
    request: Request,
    file_path: Option<PathBuf>,
    file_variables: Vec<Variable>,
    environment: Option<String>,
) -> Result<HttpResponse, ExecError> {
    let root = state.root.lock().unwrap().clone();
    let base_dir = file_path
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| root.clone())
        .unwrap_or_else(|| PathBuf::from("."));
    let settings = state.settings.lock().unwrap().exec.clone();

    let (prepared, ssl) = {
        let env_set = match &root {
            Some(r) => env::load(r).map_err(|e| ExecError::Other(e.to_string()))?,
            None => EnvironmentSet::default(),
        };
        let env_vars = env::variables(&env_set, environment.as_deref());
        let resolver = Resolver::for_request(&env_vars, &file_variables, &request.variables, Some(&base_dir));
        let prepared = exec::prepare(&request, &resolver, &base_dir, &settings)?;
        let ssl = match (&root, &environment) {
            (Some(r), Some(e)) => env::ssl_config(r, e),
            _ => Default::default(),
        };
        (prepared, ssl)
    };

    let progress_id = run_id.clone();
    let on_progress = move |received| {
        let _ = app.emit("send-progress", SendProgress { run_id: progress_id.clone(), received });
    };
    let task = tokio::spawn(async move { exec::execute_with_progress(prepared, &settings, &ssl, on_progress).await });
    state.running.lock().unwrap().insert(run_id.clone(), task.abort_handle());
    let result = task.await;
    state.running.lock().unwrap().remove(&run_id);

    match result {
        Ok(Ok(outcome)) => {
            state.bodies.lock().unwrap().push(outcome.response.id.clone(), outcome.body);
            Ok(outcome.response)
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

#[tauri::command]
async fn save_response_body<R: tauri::Runtime>(app: AppHandle<R>, response_id: String, path: PathBuf) -> CmdResult<()> {
    off_main(app, move |state| {
        let body = state.bodies.lock().unwrap().get(&response_id).ok_or("Response is no longer available")?;
        std::fs::write(&path, body).map_err(err)
    })
    .await
}

/// Beautify and the response Pretty view: re-lays out a body without changing
/// any token (`body_format`). On the blocking pool, since bodies can be large.
#[tauri::command]
async fn format_body(text: String, kind: BodyKind, mode: FormatMode) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || body_format::format_body(&text, kind, mode).map_err(err))
        .await
        .map_err(err)?
}

/// The stored body of `response_id` parsed as JSON, parsed on first use and
/// then kept (see `json_docs`). The lock isn't held while parsing, so a large
/// body doesn't hold up queries on other responses.
fn json_doc(state: &AppState, response_id: &str) -> CmdResult<Arc<JsonDocument>> {
    if let Some(parsed) = state.json_docs.lock().unwrap().get(response_id) {
        return parsed;
    }
    let body = state.bodies.lock().unwrap().get(response_id).ok_or("Response is no longer available")?;
    let parsed = JsonDocument::parse(&String::from_utf8_lossy(&body)).map(Arc::new).map_err(err);
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
            save_environments,
            send_request,
            cancel_request,
            save_response_body,
            format_body,
            filter_response,
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
