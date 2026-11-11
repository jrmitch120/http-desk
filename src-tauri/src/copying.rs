//! Copy body: the shell puts a stored body on the clipboard itself (text as
//! text, binary as base64), so a large body never has to pass through the
//! webview. Copying the filter's matches stays in the webview.

use std::sync::{Arc, RwLock};

use base64::Engine;
use httpdesk_core::exec;
use tauri::{AppHandle, Manager, Runtime};

/// What Copy body puts on the clipboard for a stored body: its text, decoded
/// the way the viewer shows it (its charset, else UTF-8), or base64 when it
/// isn't text.
pub fn clipboard_text(body: &[u8], content_type: Option<&str>) -> String {
    exec::decode_text(body, content_type).unwrap_or_else(|| base64::engine::general_purpose::STANDARD.encode(body))
}

/// Writes text to the clipboard.
pub type WriteFn = dyn Fn(String) -> Result<(), String> + Send + Sync;

/// The clipboard Copy body writes to: the OS clipboard, through the clipboard
/// plugin the app registers. Replaceable, so tests (whose app has no plugin)
/// record writes instead of touching the user's clipboard.
#[derive(Default)]
pub struct Clipboard(RwLock<Option<Arc<WriteFn>>>);

impl Clipboard {
    #[cfg(test)]
    pub fn replace(&self, f: impl Fn(String) -> Result<(), String> + Send + Sync + 'static) {
        *self.0.write().unwrap() = Some(Arc::new(f));
    }

    /// Puts `text` on the clipboard. Fails if it can't be written, or if there
    /// is no clipboard plugin (and nothing replaced it).
    pub fn write<R: Runtime>(&self, app: &AppHandle<R>, text: String) -> Result<(), String> {
        if let Some(f) = self.0.read().unwrap().clone() {
            return f(text);
        }
        let plugin =
            app.try_state::<tauri_plugin_clipboard_manager::Clipboard<R>>().ok_or("The clipboard isn't available")?;
        plugin.write_text(text).map_err(|e| e.to_string())
    }
}
