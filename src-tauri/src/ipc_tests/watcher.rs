//! Watcher resilience: the watcher skips the same folders as the explorer and
//! files nothing in the app shows, keeps the previous workspace syncing when a
//! new one can't be watched, and reports a workspace folder that disappears.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Listener;

use super::{changed_paths, Harness};

/// Folders neither the explorer nor the watcher look into.
const IGNORED: &[&str] = &[".git", ".venv", ".cache", "node_modules", "target", "dist", "build", "venv", "__pycache__"];

/// Payloads of `event`, as a channel, once the watcher has settled.
fn events(h: &Harness, event: &str) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>();
    h.webview.listen_any(event, move |e| {
        let _ = tx.send(e.payload().to_string());
    });
    rx
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

#[test]
fn churn_in_ignored_folders_and_unlisted_files_emits_no_events() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    for dir in IGNORED {
        std::fs::create_dir_all(root.join(dir).join("sub")).unwrap();
    }
    std::fs::write(root.join("a.http"), "GET https://a\n").unwrap();
    let info = h.ok("open_workspace", json!({ "path": root }));
    let listed: Vec<&str> = info["tree"]["children"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(listed, ["a.http"], "the explorer hides the ignored folders");

    let rx = events(&h, "workspace-changed");
    changed_paths(&rx, Duration::from_millis(600));

    for dir in IGNORED {
        std::fs::write(root.join(dir).join("sub/x.http"), "GET https://x\n").unwrap();
        std::fs::write(root.join(dir).join("bundle.js"), "x").unwrap();
        std::fs::create_dir(root.join(dir).join("new")).unwrap();
    }
    std::fs::write(root.join("notes.md"), "notes").unwrap();
    std::fs::write(root.join("server.log"), "log").unwrap();
    std::fs::write(root.join(".DS_Store"), "x").unwrap();
    let noise = changed_paths(&rx, Duration::from_secs(2));
    assert!(noise.is_empty(), "churn the explorer doesn't show was reported: {noise:?}");

    std::fs::write(root.join("a.http"), "GET https://changed\n").unwrap();
    std::fs::write(root.join("http-client.env.json"), "{}").unwrap();
    std::fs::create_dir(root.join("docs")).unwrap();
    let ext = changed_paths(&rx, Duration::from_secs(2));
    for p in ["a.http", "http-client.env.json", "docs"] {
        assert!(ext.contains(&s(&root.join(p))), "{p} not reported: {ext:?}");
    }
}

/// The ignore rule applies below the workspace root, not to the folders it sits in.
#[test]
fn a_workspace_inside_an_ignored_folder_still_syncs() {
    let h = Harness::new();
    let tmp = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(tmp.path()).unwrap().join(".config/target/ws");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.http"), "GET https://a\n").unwrap();
    let info = h.ok("open_workspace", json!({ "path": root }));
    assert_eq!(info["tree"]["children"][0]["name"], "a.http");

    let rx = events(&h, "workspace-changed");
    changed_paths(&rx, Duration::from_millis(600));
    std::fs::write(root.join("a.http"), "GET https://changed\n").unwrap();
    let ext = changed_paths(&rx, Duration::from_secs(2));
    assert!(ext.contains(&s(&root.join("a.http"))), "{ext:?}");
}

#[test]
fn a_workspace_that_cannot_be_watched_keeps_the_previous_one_syncing() {
    let h = Harness::new();
    let (ws_a, ws_b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (a, b) = (crate::paths::canonicalize(ws_a.path()).unwrap(), crate::paths::canonicalize(ws_b.path()).unwrap());
    std::fs::write(a.join("a.http"), "GET https://a\n").unwrap();
    h.ok("open_workspace", json!({ "path": a }));
    let rx = events(&h, "workspace-changed");
    changed_paths(&rx, Duration::from_millis(600));

    crate::watcher::fail_watching(&b);
    let err = h.call("open_workspace", json!({ "path": b })).expect_err("opening an unwatchable workspace succeeded");
    assert!(err.as_str().unwrap().contains("Could not watch"), "{err}");

    let tree = h.ok("get_tree", json!({}));
    assert_eq!(tree["path"], json!(a), "the previous workspace stays open");
    std::fs::write(a.join("a.http"), "GET https://changed\n").unwrap();
    let ext = changed_paths(&rx, Duration::from_secs(2));
    assert!(ext.contains(&s(&a.join("a.http"))), "the previous watcher stopped: {ext:?}");
}

fn assert_missing_reported(remove: impl FnOnce(&Path)) {
    let h = Harness::new();
    let parent = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(parent.path()).unwrap().join("ws");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.http"), "GET https://a\n").unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let rx = events(&h, "workspace-missing");

    remove(&root);
    let payload = rx.recv_timeout(Duration::from_secs(5)).expect("a missing workspace is reported");
    let v: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(v["root"], json!(root));
}

#[test]
fn deleting_the_workspace_folder_is_reported() {
    assert_missing_reported(|root| std::fs::remove_dir_all(root).unwrap());
}

#[test]
fn moving_the_workspace_folder_is_reported() {
    assert_missing_reported(|root| std::fs::rename(root, root.with_file_name("moved")).unwrap());
}
