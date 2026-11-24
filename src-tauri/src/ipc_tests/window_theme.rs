//! The window theme: the page asks the shell to set it for the Theme setting. The
//! mock runtime's window forgets its theme (and always reports Light), so these
//! tests read what the shell set on it from the record test builds keep.

use serde_json::json;
use tauri::{Manager, Theme};

use super::Harness;

/// The window themes the shell has set, oldest first (`None`: follows the OS).
fn themes_set(h: &Harness) -> Vec<Option<Theme>> {
    h.app.state::<crate::AppState>().window_themes.lock().unwrap().clone()
}

#[test]
fn light_and_dark_pin_the_window_theme() {
    let h = Harness::new();
    h.ok("set_window_theme", json!({ "theme": "dark" }));
    h.ok("set_window_theme", json!({ "theme": "light" }));
    assert_eq!(themes_set(&h), [Some(Theme::Dark), Some(Theme::Light)]);
}

#[test]
fn system_lets_the_window_theme_follow_the_os() {
    let h = Harness::new();
    h.ok("set_window_theme", json!({ "theme": "dark" }));
    h.ok("set_window_theme", json!({ "theme": "system" }));
    assert_eq!(themes_set(&h), [Some(Theme::Dark), None]);
}

#[test]
fn an_unknown_theme_follows_the_os_as_system_does() {
    // A hand-edited settings file can hold anything; the page passes it on.
    let h = Harness::new();
    h.ok("set_window_theme", json!({ "theme": "sepia" }));
    assert_eq!(themes_set(&h), [None]);
}
