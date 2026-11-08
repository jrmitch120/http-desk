//! The native menu bar over IPC, with the menu layout the page sends
//! (src/lib/menuLayout.ts `nativeMenu`): the shell builds it, reports clicks as
//! `menu` events and greys out or ticks items when the page says so.
//!
//! Not in src/ipc_tests: macOS builds menus on the main thread only, and libtest
//! runs tests on other threads, so this binary has no harness and runs its tests
//! one after another on the main thread.
//!
//! Every test runs on every OS, but MockRuntime can't do the same on each:
//! - macOS: everything runs. The menu is the app's, not a window's.
//! - Windows: Tauri attaches the menu to MockRuntime's dummy window handle, which
//!   Win32 ignores. muda reads a label back without the "\tCtrl+S" the page puts
//!   after it (see `save`), so that part isn't checked.
//! - Linux: Tauri can't attach the menu to the window at all (see `Harness::new`).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::MenuItemKind;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Listener;

// The origin Tauri serves the app from; capabilities only apply to it.
#[cfg(windows)]
const APP_URL: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const APP_URL: &str = "tauri://localhost";

struct Harness {
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
}

impl Harness {
    fn new() -> Self {
        let app = httpdesk_lib::test_support::with_commands(mock_builder()).build(mock_context(noop_assets())).unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default());
        // On GTK, `AppHandle::set_menu` also attaches the app's menu to every
        // window that has no menu of its own, through the window's GTK handle,
        // and MockRuntime has none (`gtk_window()` is `unimplemented!()`). A menu
        // of its own keeps Tauri off this window. Everything the shell does with
        // the layout still runs, and `app.menu()` is still the menu it built.
        #[cfg(not(any(target_os = "macos", windows)))]
        let window = window.menu(tauri::menu::Menu::new(&app).unwrap());
        let webview = window.build().unwrap();
        Harness { app, webview }
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: APP_URL.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
        .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }

    /// The menu bar the app shows, one line per menu (see `entry`).
    fn menu_bar(&self) -> Vec<String> {
        let menu = self.app.menu().expect("the app has a menu");
        menu.items().unwrap().iter().map(entry).collect()
    }

    /// The ids of the `menu` events the app sends while `f` runs.
    fn menu_events(&self, f: impl FnOnce()) -> Vec<String> {
        let (tx, rx) = mpsc::channel();
        let listener = self.app.listen("menu", move |e| {
            let payload: Value = serde_json::from_str(e.payload()).unwrap();
            tx.send(payload["id"].as_str().unwrap().to_string()).unwrap();
        });
        f();
        let mut ids = Vec::new();
        while let Ok(id) = rx.recv_timeout(Duration::from_millis(200)) {
            ids.push(id);
        }
        self.app.unlisten(listener);
        ids
    }
}

/// A submenu as "Label: entry, entry"; an item as `id "Label"`, with "(off)" when
/// greyed out and [x] / [ ] when it is a checkbox; an OS item as its text in
/// parentheses; a separator as "-".
fn entry(item: &MenuItemKind<MockRuntime>) -> String {
    match item {
        MenuItemKind::Submenu(s) => {
            let items: Vec<String> = s.items().unwrap().iter().map(entry).collect();
            let off = if s.is_enabled().unwrap() { "" } else { " (off)" };
            format!("{}{off}: {}", s.text().unwrap(), items.join(", "))
        }
        MenuItemKind::MenuItem(i) => {
            let off = if i.is_enabled().unwrap() { "" } else { " (off)" };
            format!("{} {:?}{off}", i.id().0, i.text().unwrap())
        }
        MenuItemKind::Check(c) => {
            let off = if c.is_enabled().unwrap() { "" } else { " (off)" };
            let tick = if c.is_checked().unwrap() { "[x]" } else { "[ ]" };
            format!("{tick} {} {:?}{off}", c.id().0, c.text().unwrap())
        }
        MenuItemKind::Predefined(p) => match p.text().unwrap().as_str() {
            "" => "-".into(),
            text => format!("({text})"),
        },
        MenuItemKind::Icon(_) => "icon".into(),
    }
}

/// Save as the page sends it on this OS (ADR-0005): a key equivalent on macOS,
/// the shortcut in the label on Windows, neither on Linux. (A macOS key
/// equivalent like "Cmd+S" is an error on Windows.) It reads back as
/// `save "Save"` everywhere: on Windows muda leaves out what follows the tab.
fn save(enabled: bool) -> Value {
    let (label, accelerator) = if cfg!(target_os = "macos") {
        ("Save", json!("Cmd+S"))
    } else if cfg!(windows) {
        ("Save\tCtrl+S", Value::Null)
    } else {
        ("Save", Value::Null)
    };
    json!({ "kind": "item", "id": "save", "label": label, "accelerator": accelerator, "enabled": enabled, "checked": null })
}

/// A layout like the page's, small enough to read.
fn layout(recents: &[&str]) -> Value {
    let recent: Vec<Value> = recents
        .iter()
        .map(|p| json!({ "kind": "item", "id": format!("open-recent:{p}"), "label": p.rsplit('/').next(), "accelerator": null, "enabled": true, "checked": null }))
        .collect();
    json!([
        { "label": "File", "items": [
            { "kind": "item", "id": "open-folder", "label": "Open Folder…", "accelerator": null, "enabled": true, "checked": null },
            { "kind": "submenu", "label": "Open Recent", "enabled": !recent.is_empty(), "items": recent },
            { "kind": "separator" },
            save(false),
        ]},
        { "label": "Edit", "items": [
            { "kind": "predefined", "item": "copy", "label": "Copy" },
            { "kind": "predefined", "item": "paste", "label": "Paste" },
        ]},
        { "label": "View", "items": [
            { "kind": "submenu", "label": "Theme", "enabled": true, "items": [
                { "kind": "item", "id": "theme-light", "label": "Light", "accelerator": null, "enabled": true, "checked": false },
                { "kind": "item", "id": "theme-dark", "label": "Dark", "accelerator": null, "enabled": true, "checked": true },
            ]},
        ]},
        { "label": "Request", "items": [
            save(false),
        ]},
    ])
}

fn builds_the_menu_bar_from_the_layout() {
    let h = Harness::new();
    h.ok("set_menu", json!({ "layout": layout(&["/work/api"]) }));
    assert_eq!(
        h.menu_bar(),
        [
            r#"File: open-folder "Open Folder…", Open Recent: open-recent:/work/api "api", -, save "Save" (off)"#,
            "Edit: (Copy), (Paste)",
            r#"View: Theme: [ ] theme-light "Light", [x] theme-dark "Dark""#,
            r#"Request: save "Save" (off)"#,
        ]
    );
}

fn an_empty_open_recent_is_greyed_out() {
    let h = Harness::new();
    h.ok("set_menu", json!({ "layout": layout(&[]) }));
    assert!(
        h.menu_bar()[0].starts_with(r#"File: open-folder "Open Folder…", Open Recent (off): , -"#),
        "{:?}",
        h.menu_bar()
    );
}

fn clicking_an_item_sends_a_menu_event_with_its_id() {
    let h = Harness::new();
    h.ok("set_menu", json!({ "layout": layout(&["/work/api"]) }));
    let handle = h.app.handle().clone();
    let ids = h.menu_events(|| {
        httpdesk_lib::test_support::menu_clicked(&handle, "theme-dark");
        httpdesk_lib::test_support::menu_clicked(&handle, "open-recent:/work/api");
    });
    assert_eq!(ids, ["theme-dark", "open-recent:/work/api"]);
}

fn only_the_layouts_own_items_send_events() {
    let h = Harness::new();
    h.ok("set_menu", json!({ "layout": layout(&["/work/api"]) }));
    // A new layout: the old recent workspace's item is gone.
    h.ok("set_menu", json!({ "layout": layout(&["/work/shop"]) }));
    assert!(h.menu_bar()[0].contains(r#"open-recent:/work/shop "shop""#), "{:?}", h.menu_bar());
    let handle = h.app.handle().clone();
    let ids = h.menu_events(|| {
        // OS items (Copy, Quit…) are the OS's to run, and their ids are muda's.
        httpdesk_lib::test_support::menu_clicked(&handle, "1");
        httpdesk_lib::test_support::menu_clicked(&handle, "open-recent:/work/api");
    });
    assert!(ids.is_empty(), "{ids:?}");
}

fn the_page_greys_out_and_ticks_items_by_id() {
    let h = Harness::new();
    h.ok("set_menu", json!({ "layout": layout(&[]) }));
    h.ok(
        "set_menu_state",
        json!({ "changes": [
            { "id": "save", "enabled": true },
            { "id": "open-folder", "enabled": false },
            { "id": "theme-light", "checked": true },
            { "id": "theme-dark", "checked": false },
            { "id": "no-such-item", "enabled": false },
        ]}),
    );
    let bar = h.menu_bar();
    // Both Save items: File's and Request's.
    assert!(bar[0].ends_with(r#"save "Save""#), "{bar:?}");
    assert!(bar[0].starts_with(r#"File: open-folder "Open Folder…" (off)"#), "{bar:?}");
    assert_eq!(bar[2], r#"View: Theme: [x] theme-light "Light", [ ] theme-dark "Dark""#);
    assert_eq!(bar[3], r#"Request: save "Save""#);
}

fn the_window_and_help_menus_are_the_ones_macos_treats_as_such() {
    let h = Harness::new();
    let item = json!({ "kind": "predefined", "item": "minimize", "label": "Minimize" });
    h.ok(
        "set_menu",
        json!({ "layout": [
            { "label": "File", "items": [item] },
            { "label": "Window", "role": "window", "items": [item] },
            { "label": "Help", "role": "help", "items": [item] },
        ]}),
    );
    let menu = h.app.menu().unwrap();
    let text = |id: &str| match menu.get(id) {
        Some(MenuItemKind::Submenu(s)) => s.text().unwrap(),
        other => panic!("no submenu {id}: {:?}", other.map(|o| o.id().clone())),
    };
    assert_eq!(text(tauri::menu::WINDOW_SUBMENU_ID), "Window");
    assert_eq!(text(tauri::menu::HELP_SUBMENU_ID), "Help");
}

fn main() {
    let tests: &[(&str, fn())] = &[
        ("builds_the_menu_bar_from_the_layout", builds_the_menu_bar_from_the_layout),
        ("an_empty_open_recent_is_greyed_out", an_empty_open_recent_is_greyed_out),
        ("clicking_an_item_sends_a_menu_event_with_its_id", clicking_an_item_sends_a_menu_event_with_its_id),
        ("only_the_layouts_own_items_send_events", only_the_layouts_own_items_send_events),
        ("the_page_greys_out_and_ticks_items_by_id", the_page_greys_out_and_ticks_items_by_id),
        (
            "the_window_and_help_menus_are_the_ones_macos_treats_as_such",
            the_window_and_help_menus_are_the_ones_macos_treats_as_such,
        ),
    ];
    println!("\nrunning {} tests", tests.len());
    let mut failed = Vec::new();
    for (name, test) in tests {
        let ok = catch_unwind(AssertUnwindSafe(test)).is_ok();
        println!("test {name} ... {}", if ok { "ok" } else { "FAILED" });
        if !ok {
            failed.push(*name);
        }
    }
    println!(
        "\ntest result: {}. {} passed; {} failed\n",
        if failed.is_empty() { "ok" } else { "FAILED" },
        tests.len() - failed.len(),
        failed.len()
    );
    if !failed.is_empty() {
        std::process::exit(1);
    }
}
