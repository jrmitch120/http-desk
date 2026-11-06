//! Tauri shell: thin commands over `httpdesk-core`, plus the workspace file
//! watcher. All domain logic lives in the core crate.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use httpdesk_core::env::{self, EnvironmentSet, SaveReport};
use httpdesk_core::exec::{self, ExecSettings, HttpResponse};
use httpdesk_core::openapi::{GenerateOptions, OpenApiDoc, SpecSummary};
use httpdesk_core::vars::Resolver;
use httpdesk_core::workspace::{self, SearchHit, TreeNode};
use httpdesk_core::{HttpFile, Request, Variable};
use notify_debouncer_mini::{new_debouncer, notify::RecommendedWatcher, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    exec: ExecSettings,
    recent_workspaces: Vec<PathBuf>,
    /// Last selected environment per workspace.
    environments: HashMap<String, String>,
    theme: String,
    layout: String,
    /// Look for a new release on startup.
    check_updates: bool,
    /// Show param/header descriptions under each row.
    show_descriptions: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            exec: ExecSettings::default(),
            recent_workspaces: vec![],
            environments: HashMap::new(),
            theme: "dark".into(),
            layout: "horizontal".into(),
            check_updates: true,
            show_descriptions: true,
        }
    }
}

#[derive(Default)]
struct AppState {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Content hash of files we wrote, to ignore our own watcher events.
    written: Arc<Mutex<HashMap<PathBuf, u64>>>,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Recent response bodies by response id (for "save to file").
    bodies: Mutex<VecDeque<(String, Vec<u8>)>>,
    specs: Mutex<HashMap<String, OpenApiDoc>>,
    settings: Mutex<AppSettings>,
}

impl AppState {
    fn root(&self) -> CmdResult<PathBuf> {
        self.root.lock().unwrap().clone().ok_or_else(|| "No workspace is open".to_string())
    }

    fn write_file(&self, path: &Path, text: &str) -> CmdResult<()> {
        self.written.lock().unwrap().insert(path.to_path_buf(), workspace::content_hash(text.as_bytes()));
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
    let dir = std::env::var_os("HTTPDESK_CONFIG_DIR").map(PathBuf::from).or_else(|| app.path().app_config_dir().ok())?;
    Some(dir.join("settings.json"))
}

fn persist_settings<R: tauri::Runtime>(app: &AppHandle<R>, settings: &AppSettings) {
    if let Some(path) = settings_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(path, serde_json::to_string_pretty(settings).unwrap());
    }
}

// ------------------------------------------------------------------ workspace

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: PathBuf,
    tree: TreeNode,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeEvent {
    paths: Vec<PathBuf>,
}

fn is_watched_noise(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    name.ends_with(".httpdesk-tmp")
        || path.components().any(|c| matches!(c.as_os_str().to_str(), Some(".git" | "node_modules" | "target")))
}

fn start_watcher<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState, root: &Path) -> CmdResult<()> {
    let app = app.clone();
    let written = state.written.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<PathBuf> = Vec::new();
        for ev in events {
            if is_watched_noise(&ev.path) || paths.contains(&ev.path) {
                continue;
            }
            // Drop events for content we wrote ourselves.
            if let Ok(bytes) = std::fs::read(&ev.path) {
                let mut map = written.lock().unwrap();
                if map.get(&ev.path) == Some(&workspace::content_hash(&bytes)) {
                    continue;
                }
                map.remove(&ev.path);
            }
            paths.push(ev.path);
        }
        if !paths.is_empty() {
            let _ = app.emit("workspace-changed", ChangeEvent { paths });
        }
    })
    .map_err(err)?;
    debouncer.watcher().watch(root, RecursiveMode::Recursive).map_err(err)?;
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
fn open_workspace<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: PathBuf) -> CmdResult<WorkspaceInfo> {
    let root = path.canonicalize().map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let tree = workspace::tree(&root).map_err(err)?;
    *state.watcher.lock().unwrap() = None;
    start_watcher(&app, &state, &root)?;
    *state.root.lock().unwrap() = Some(root.clone());

    let mut settings = state.settings.lock().unwrap();
    settings.recent_workspaces.retain(|p| p != &root);
    settings.recent_workspaces.insert(0, root.clone());
    settings.recent_workspaces.truncate(10);
    persist_settings(&app, &settings);
    Ok(WorkspaceInfo { root, tree })
}

#[tauri::command]
fn get_tree(state: State<'_, AppState>) -> CmdResult<TreeNode> {
    workspace::tree(&state.root()?).map_err(err)
}

#[tauri::command]
fn search_requests(state: State<'_, AppState>, query: String) -> CmdResult<Vec<SearchHit>> {
    Ok(workspace::search(&state.root()?, &query))
}

// ------------------------------------------------------------------ files

#[tauri::command]
fn read_http_file(path: PathBuf) -> CmdResult<HttpFile> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Ok(httpdesk_core::parse(&text))
}

/// Serializes and writes the file, returning it re-parsed (fresh `raw` snapshots).
#[tauri::command]
fn save_http_file(state: State<'_, AppState>, path: PathBuf, file: HttpFile) -> CmdResult<HttpFile> {
    let text = httpdesk_core::serialize(&file);
    state.write_file(&path, &text)?;
    Ok(httpdesk_core::parse(&text))
}

#[tauri::command]
fn render_request(request: Request) -> String {
    httpdesk_core::render_request(&Request { leading: String::new(), ..request })
}

#[tauri::command]
fn create_file(state: State<'_, AppState>, path: PathBuf, content: String) -> CmdResult<()> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    state.write_file(&path, &content)
}

#[tauri::command]
fn create_dir(path: PathBuf) -> CmdResult<()> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn rename_path(from: PathBuf, to: PathBuf) -> CmdResult<()> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Could not move {}: {e}", from.display()))
}

#[tauri::command]
fn delete_path(path: PathBuf) -> CmdResult<()> {
    trash::delete(&path).or_else(|_| {
        if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) }.map_err(err)
    })
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
    // Pre-register hashes is not possible before serialization; mark both env files after saving.
    let report = env::save(&root, &set).map_err(err)?;
    for name in [env::ENV_FILE, env::PRIVATE_ENV_FILE] {
        let p = root.join(name);
        if let Ok(bytes) = std::fs::read(&p) {
            state.written.lock().unwrap().insert(p, workspace::content_hash(&bytes));
        }
    }
    Ok(report)
}

// ------------------------------------------------------------------ execution

#[tauri::command]
async fn send_request(
    state: State<'_, AppState>,
    run_id: String,
    request: Request,
    file_path: Option<PathBuf>,
    file_variables: Vec<Variable>,
    environment: Option<String>,
) -> CmdResult<HttpResponse> {
    let root = state.root.lock().unwrap().clone();
    let base_dir = file_path
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| root.clone())
        .unwrap_or_else(|| PathBuf::from("."));
    let settings = state.settings.lock().unwrap().exec.clone();

    let (prepared, ssl) = {
        let env_set = match &root {
            Some(r) => env::load(r).map_err(err)?,
            None => EnvironmentSet::default(),
        };
        let env_vars = env::variables(&env_set, environment.as_deref());
        let resolver = Resolver::for_request(&env_vars, &file_variables, &request.variables, Some(&base_dir));
        let prepared = exec::prepare(&request, &resolver, &base_dir, &settings).map_err(err)?;
        let ssl = match (&root, &environment) {
            (Some(r), Some(e)) => env::ssl_config(r, e),
            _ => Default::default(),
        };
        (prepared, ssl)
    };

    let task = tokio::spawn(async move { exec::execute(prepared, &settings, &ssl).await });
    state.running.lock().unwrap().insert(run_id.clone(), task.abort_handle());
    let result = task.await;
    state.running.lock().unwrap().remove(&run_id);

    match result {
        Ok(Ok(outcome)) => {
            let mut bodies = state.bodies.lock().unwrap();
            bodies.push_back((outcome.response.id.clone(), outcome.body));
            while bodies.len() > 20 {
                bodies.pop_front();
            }
            Ok(outcome.response)
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) if e.is_cancelled() => Err("Request cancelled".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn cancel_request(state: State<'_, AppState>, run_id: String) {
    if let Some(handle) = state.running.lock().unwrap().remove(&run_id) {
        handle.abort();
    }
}

#[tauri::command]
fn save_response_body(state: State<'_, AppState>, response_id: String, path: PathBuf) -> CmdResult<()> {
    let bodies = state.bodies.lock().unwrap();
    let (_, body) = bodies.iter().find(|(id, _)| *id == response_id).ok_or("Response is no longer available")?;
    std::fs::write(&path, body).map_err(err)
}

// ------------------------------------------------------------------ settings

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, settings: AppSettings) {
    persist_settings(&app, &settings);
    *state.settings.lock().unwrap() = settings;
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
fn openapi_generate(
    state: State<'_, AppState>,
    source: String,
    options: GenerateOptions,
    output_dir: PathBuf,
    overwrite: bool,
    dry_run: bool,
) -> CmdResult<GenerateReport> {
    let output = {
        let specs = state.specs.lock().unwrap();
        let doc = specs.get(source.trim()).ok_or("Load the specification first")?;
        doc.generate(&options)
    };
    let files: Vec<PathBuf> = output.files.iter().map(|f| output_dir.join(&f.relative_path)).collect();
    let conflicts: Vec<PathBuf> = files.iter().filter(|p| p.exists()).cloned().collect();
    // Environments go to the workspace root when generating inside it.
    let env_dir = match state.root.lock().unwrap().clone() {
        Some(root) if output_dir.starts_with(&root) => root,
        _ => output_dir.clone(),
    };
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

    std::fs::create_dir_all(&output_dir).map_err(err)?;
    for (gen, path) in output.files.iter().zip(&report.files) {
        state.write_file(path, &httpdesk_core::serialize(&gen.file))?;
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

/// Registers state and commands (shared by the app and the IPC tests).
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(AppState::default())
        .setup(|app| {
            if let Some(text) = settings_path(app.handle()).and_then(|p| std::fs::read_to_string(p).ok()) {
                if let Ok(s) = serde_json::from_str::<AppSettings>(&text) {
                    *app.state::<AppState>().settings.lock().unwrap() = s;
                }
            }
            Ok(())
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
            path_exists,
            load_environments,
            save_environments,
            send_request,
            cancel_request,
            save_response_body,
            get_settings,
            save_settings,
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
    )
        .run(tauri::generate_context!())
        .expect("error while running HttpDesk");
}

#[cfg(test)]
mod ipc_tests;
