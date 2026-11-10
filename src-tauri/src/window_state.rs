//! The window remembers its size, position, maximised and fullscreen state
//! between launches (tauri-plugin-window-state). The plugin saves it at quit;
//! `show_restored` puts it back on the hidden main window, then shows it.
//!
//! When the saved position isn't on any connected monitor (one was unplugged),
//! the plugin leaves placement to the OS, so the window never opens off-screen.

use std::path::PathBuf;

use tauri::plugin::TauriPlugin;
use tauri::{Runtime, WebviewWindow};
use tauri_plugin_window_state::{Builder, StateFlags, WindowExt, DEFAULT_FILENAME};

/// Visibility and decorations aren't remembered: the window always opens shown,
/// with native chrome (ADR-0002).
const REMEMBERED: StateFlags =
    StateFlags::SIZE.union(StateFlags::POSITION).union(StateFlags::MAXIMIZED).union(StateFlags::FULLSCREEN);

/// The plugin, saving to `config_dir` (`HTTPDESK_CONFIG_DIR`) when given, else
/// to the app's config folder.
pub fn plugin<R: Runtime>(config_dir: Option<PathBuf>) -> TauriPlugin<R> {
    let mut builder = Builder::new()
        .with_state_flags(REMEMBERED)
        // Restored by `show_restored`, so the window is shown after, not before.
        .skip_initial_state("main");
    if let Some(dir) = config_dir {
        // The plugin joins this to the app's config folder; an absolute path replaces it.
        builder = builder.with_filename(dir.join(DEFAULT_FILENAME).to_string_lossy());
    }
    builder.build()
}

/// Restores the saved state of `window`, created hidden so it never appears at
/// the default size first, then shows it. It's shown even if restoring fails.
pub fn show_restored<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let _ = window.restore_state(REMEMBERED);
    window.show()?;
    window.set_focus()
}
