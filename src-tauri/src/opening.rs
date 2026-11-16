//! "Open in default editor" for script files (#142). The shell opens the file
//! itself, after confining it to the workspace (`ScriptFiles::locate`), so the
//! webview has no permission to open paths (see `tests/capabilities.rs`).

use std::path::Path;
use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Manager, Runtime};

/// Opens a file.
pub type OpenFn = dyn Fn(&Path) -> Result<(), String> + Send + Sync;

/// What opens a file in the user's editor: the OS, through the opener plugin the
/// app registers. Replaceable, so tests (whose app has no plugin) record what
/// would be opened instead of opening it.
#[derive(Default)]
pub struct Opener(RwLock<Option<Arc<OpenFn>>>);

impl Opener {
    #[cfg(test)]
    pub fn replace(&self, f: impl Fn(&Path) -> Result<(), String> + Send + Sync + 'static) {
        *self.0.write().unwrap() = Some(Arc::new(f));
    }

    /// Opens `path` (a `.js` file) in the app the OS edits it with. Fails if it
    /// can't, or if there is no opener plugin (and nothing replaced it).
    pub fn open<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) -> Result<(), String> {
        if let Some(f) = self.0.read().unwrap().clone() {
            return f(path);
        }
        let plugin = app.try_state::<tauri_plugin_opener::Opener<R>>().ok_or("Files can't be opened here")?;
        // Windows opens a `.js` file with Windows Script Host, which runs it, so
        // it's opened in Notepad there instead.
        let with = if cfg!(windows) { Some("notepad.exe") } else { None };
        plugin.open_path(path.to_string_lossy(), with).map_err(|e| e.to_string())
    }
}
