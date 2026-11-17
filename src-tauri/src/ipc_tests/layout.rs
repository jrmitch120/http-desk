//! The Layout over IPC: each workspace's Layout is saved and loaded by its
//! canonical path, in the config folder and never inside the workspace.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::Harness;

fn workspace() -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("api.http"), "GET https://example.com\n").unwrap();
    (ws, root)
}

fn layout(file: &str) -> Value {
    json!({
        "tabs": [{ "path": file, "name": "List", "method": "GET", "url": "https://example.com", "position": 0,
                   "section": "headers", "responseView": { "tab": "body", "mode": "raw", "wrap": true } }],
        "active": 0,
        "expanded": ["", "api"],
    })
}

/// Every file under `dir`, relative to it.
fn files_under(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            out.extend(files_under(&path).into_iter().map(|f| format!("{name}/{f}")));
        } else {
            out.push(path.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    out.sort();
    out
}

#[test]
fn each_workspace_keeps_its_own_layout_in_the_config_folder() {
    let h = Harness::new();
    let (ws_a, a) = workspace();
    let (ws_b, b) = workspace();
    assert_eq!(h.ok("load_layout", json!({ "root": a })), Value::Null, "nothing saved yet");

    h.ok("save_layout", json!({ "root": a, "layout": layout("a.http") }));
    h.ok("save_layout", json!({ "root": b, "layout": layout("b.http") }));
    // Saved again once changes settle: the last one wins.
    let mut changed = layout("a.http");
    changed["active"] = Value::Null;
    h.ok("save_layout", json!({ "root": a, "layout": changed }));

    assert_eq!(h.ok("load_layout", json!({ "root": a })), changed);
    assert_eq!(h.ok("load_layout", json!({ "root": b })), layout("b.http"));
    // Keyed by the canonical path, however the folder is named.
    assert_eq!(h.ok("load_layout", json!({ "root": a.join("..").join(a.file_name().unwrap()) })), changed);

    // Nothing is written inside either workspace.
    assert_eq!(files_under(ws_a.path()), ["api.http"]);
    assert_eq!(files_under(ws_b.path()), ["api.http"]);
    let stored: Vec<String> = files_under(&h.config_dir()).into_iter().filter(|f| f.starts_with("layouts/")).collect();
    assert_eq!(stored.len(), 2, "{stored:?}");
}

#[test]
fn a_damaged_layout_loads_as_none() {
    let h = Harness::new();
    let (_ws, root) = workspace();
    h.ok("save_layout", json!({ "root": root, "layout": layout("a.http") }));
    let dir = h.config_dir().join("layouts");
    let file = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
    std::fs::write(&file, "{ not json").unwrap();

    assert_eq!(h.ok("load_layout", json!({ "root": root })), Value::Null);
}
