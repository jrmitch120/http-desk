//! Window state: the window's size, position, maximised and fullscreen state are
//! saved at quit, in the app's config folder. The mock runtime's window is always
//! at (0, 0), 0×0, not maximised or fullscreen, visible and without decorations,
//! and it never really moves or resizes, so these tests check what is saved, not
//! what is restored (that is on the manual checklist in #97).

use std::path::Path;

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{Manager, RunEvent};

const STATE_FILE: &str = ".window-state.json";

/// Launches the app as `run()` does, with the main window from tauri.conf.json and
/// its files in `cfg`, then quits by closing the window; returns once it has exited.
fn launch_and_quit(cfg: &Path) {
    let mut context = mock_context(noop_assets());
    let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    context.config_mut().app.windows = serde_json::from_value(conf["app"]["windows"].clone()).unwrap();
    let builder = mock_builder()
        .manage(crate::ConfigDir(cfg.to_path_buf()))
        .plugin(crate::window_state::plugin(Some(cfg.to_path_buf())));
    let app = crate::with_commands(builder, crate::theme::create_main_window).build(context).unwrap();
    app.run_return(|app, event| {
        if let RunEvent::Ready = event {
            app.get_webview_window("main").expect("main window created at setup").close().unwrap();
        }
    });
}

fn saved_state(cfg: &Path) -> Value {
    let text = std::fs::read_to_string(cfg.join(STATE_FILE)).expect("window state saved in the config folder");
    serde_json::from_str(&text).unwrap()
}

#[test]
fn a_first_launch_saves_the_window_state_in_the_config_folder() {
    let cfg = tempfile::tempdir().unwrap();
    launch_and_quit(cfg.path());
    let main = &saved_state(cfg.path())["main"];
    assert_eq!((main["x"].clone(), main["y"].clone()), (json!(0), json!(0)));
    assert_eq!(main["maximized"], json!(false));
    assert_eq!(main["fullscreen"], json!(false));
}

#[test]
fn quitting_saves_position_maximised_and_fullscreen_but_not_visibility_or_decorations() {
    let cfg = tempfile::tempdir().unwrap();
    // A previous run left the window maximised and fullscreen at (40, 30); the
    // visibility and decorations in the file are the opposite of the mock window's.
    let before = json!({ "main": {
        "width": 1200, "height": 800, "x": 40, "y": 30, "prev_x": 40, "prev_y": 30,
        "maximized": true, "visible": false, "decorated": true, "fullscreen": true,
    }});
    std::fs::write(cfg.path().join(STATE_FILE), before.to_string()).unwrap();

    launch_and_quit(cfg.path());

    let main = &saved_state(cfg.path())["main"];
    // What the window was at quit.
    assert_eq!((main["x"].clone(), main["y"].clone()), (json!(0), json!(0)), "position");
    assert_eq!(main["maximized"], json!(false), "maximised");
    assert_eq!(main["fullscreen"], json!(false), "fullscreen");
    // The plugin never saves a 0×0 size, so the last real one is kept.
    assert_eq!((main["width"].clone(), main["height"].clone()), (json!(1200), json!(800)), "size");
    // Not remembered: the window always opens shown, with native chrome (ADR-0002).
    assert_eq!(main["visible"], json!(false), "visibility isn't saved");
    assert_eq!(main["decorated"], json!(true), "decorations aren't saved");
}
