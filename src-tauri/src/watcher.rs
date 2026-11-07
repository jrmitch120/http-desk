//! Workspace file watcher. Emits to the UI:
//! - `workspace-changed` `{ paths }`: external changes the app shows (`.http`/`.rest`
//!   and environment files, and folders), minus the ones our own file operations caused.
//! - `workspace-missing` `{ root }`: the workspace folder was deleted or moved (once).
//! - `workspace-watch-error` `{ message }`: the watcher itself reported an error.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use httpdesk_core::{env, workspace};
use notify_debouncer_mini::notify::event::{AccessKind, AccessMode};
use notify_debouncer_mini::notify::{self, EventHandler, EventKind, RecommendedWatcher, RecursiveMode, WatcherKind};
use notify_debouncer_mini::{new_debouncer_opt, Config, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::self_writes::SelfWrites;

/// The platform watcher, minus events for reading a file. Linux's inotify reports every
/// open, so without this, reading a file (the user's tools, a send loading the env files,
/// even `SelfWrites::is_own` checking content) would be reported as a change to it.
struct ChangeWatcher(RecommendedWatcher);

/// Whether `kind` reports a file being read rather than changed. Closing a file that
/// was open for writing stays, as it marks the end of a write.
fn is_read(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Access(a) if *a != AccessKind::Close(AccessMode::Write))
}

impl notify::Watcher for ChangeWatcher {
    fn new<F: EventHandler>(mut handler: F, config: notify::Config) -> notify::Result<Self> {
        let changes = move |res: notify::Result<notify::Event>| {
            if !res.as_ref().is_ok_and(|e| is_read(&e.kind)) {
                handler.handle_event(res);
            }
        };
        RecommendedWatcher::new(changes, config).map(Self)
    }

    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
        self.0.watch(path, recursive_mode)
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.0.unwatch(path)
    }

    fn configure(&mut self, option: notify::Config) -> notify::Result<bool> {
        self.0.configure(option)
    }

    fn kind() -> WatcherKind {
        RecommendedWatcher::kind()
    }
}

/// How often the workspace folder's existence is checked, for platforms that
/// don't report the watched folder itself being moved away.
const ROOT_POLL: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeEvent {
    paths: Vec<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissingEvent {
    root: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchErrorEvent {
    message: String,
}

/// Whether an event at `path` can change anything the app shows. Uses the
/// explorer's ignore rule, and reads nothing from disk except the entry's type.
fn is_relevant(root: &Path, path: &Path) -> bool {
    if path == root {
        return true;
    }
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    if name.ends_with(".httpdesk-tmp") || workspace::inside_ignored_dir(root, path) {
        return false;
    }
    if workspace::is_http_file(path) || name == env::ENV_FILE || name == env::PRIVATE_ENV_FILE {
        return true;
    }
    // Anything else only matters as a folder the explorer lists, or one that just went away.
    let folder_or_gone = std::fs::symlink_metadata(path).map_or(true, |m| m.is_dir());
    folder_or_gone && !workspace::is_ignored_dir(&name)
}

/// A running watch. Dropping it stops both the watcher and the root check.
pub struct Watcher {
    _debouncer: Debouncer<ChangeWatcher>,
    _stop_polling: mpsc::Sender<()>,
}

/// Reports the workspace folder disappearing, once until it is back.
struct RootCheck<R: tauri::Runtime> {
    app: AppHandle<R>,
    root: PathBuf,
    missing: AtomicBool,
}

impl<R: tauri::Runtime> RootCheck<R> {
    fn check(&self) {
        let gone = !self.root.is_dir();
        if !gone {
            self.missing.store(false, Ordering::SeqCst);
        } else if !self.missing.swap(true, Ordering::SeqCst) {
            let _ = self.app.emit("workspace-missing", MissingEvent { root: self.root.clone() });
        }
    }
}

/// Starts watching `root`. The caller swaps it in only on success, so a failure
/// leaves the previous workspace's watcher running.
pub fn start<R: tauri::Runtime>(app: &AppHandle<R>, self_writes: SelfWrites, root: &Path) -> Result<Watcher, String> {
    let failed = |e: &dyn std::fmt::Display| format!("Could not watch {} for changes: {e}", root.display());
    #[cfg(test)]
    if UNWATCHABLE.lock().unwrap().iter().any(|p| p == root) {
        return Err(failed(&"simulated failure"));
    }
    let root_check =
        Arc::new(RootCheck { app: app.clone(), root: root.to_path_buf(), missing: AtomicBool::new(false) });
    let (app, watched, check) = (app.clone(), root.to_path_buf(), root_check.clone());
    let config = Config::default().with_timeout(Duration::from_millis(250));
    let mut debouncer = new_debouncer_opt::<_, ChangeWatcher>(config, move |res: DebounceEventResult| {
        let events = match res {
            Ok(events) => events,
            Err(e) => {
                let _ = app.emit("workspace-watch-error", WatchErrorEvent { message: e.to_string() });
                return;
            }
        };
        // Before the changes, so the UI knows why the tree can't refresh.
        check.check();
        let mut paths: Vec<PathBuf> = Vec::new();
        for ev in events {
            if paths.contains(&ev.path) || !is_relevant(&watched, &ev.path) || self_writes.is_own(&ev.path) {
                continue;
            }
            paths.push(ev.path);
        }
        if !paths.is_empty() {
            let _ = app.emit("workspace-changed", ChangeEvent { paths });
        }
    })
    .map_err(|e| failed(&e))?;
    debouncer.watcher().watch(root, RecursiveMode::Recursive).map_err(|e| failed(&e))?;

    let (stop_polling, stopped) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(ROOT_POLL) {
            root_check.check();
        }
    });
    Ok(Watcher { _debouncer: debouncer, _stop_polling: stop_polling })
}

/// Roots `start` refuses, to exercise a failed watch in tests.
#[cfg(test)]
static UNWATCHABLE: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
pub fn fail_watching(root: &Path) {
    UNWATCHABLE.lock().unwrap().push(root.to_path_buf());
}
