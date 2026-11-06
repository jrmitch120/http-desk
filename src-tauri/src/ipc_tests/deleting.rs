//! Deleting: `delete_path` only ever moves to the trash, and reports when the
//! trash is unavailable instead of unlinking; `delete_permanently` is the
//! explicit, confirmed fallback. The trash here is the Harness's fake (a temp
//! folder), never the user's real Trash.

use std::path::PathBuf;

use serde_json::json;

use super::Harness;

/// An open workspace holding `a.http` and `dir/inner.http`.
struct Fixture {
    h: Harness,
    _ws: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let h = Harness::new();
        let ws = tempfile::tempdir().unwrap();
        let root = ws.path().canonicalize().unwrap();
        std::fs::write(root.join("a.http"), "GET https://a\n").unwrap();
        std::fs::create_dir(root.join("dir")).unwrap();
        std::fs::write(root.join("dir/inner.http"), "GET https://inner\n").unwrap();
        h.ok("open_workspace", json!({ "path": root }));
        Fixture { h, _ws: ws, root }
    }
}

#[test]
fn delete_moves_files_and_folders_to_the_trash() {
    let f = Fixture::new();

    assert_eq!(f.h.ok("delete_path", json!({ "path": f.root.join("a.http") })), "trashed");
    assert_eq!(f.h.ok("delete_path", json!({ "path": f.root.join("dir") })), "trashed");

    assert!(!f.root.join("a.http").exists() && !f.root.join("dir").exists());
    assert_eq!(f.h.trashed(), vec!["a.http", "dir"]);
}

#[test]
fn delete_reports_an_unavailable_trash_and_leaves_everything_in_place() {
    let f = Fixture::new();
    f.h.trash_unavailable();

    assert_eq!(f.h.ok("delete_path", json!({ "path": f.root.join("a.http") })), "trashUnavailable");
    assert_eq!(f.h.ok("delete_path", json!({ "path": f.root.join("dir") })), "trashUnavailable");

    assert_eq!(std::fs::read_to_string(f.root.join("a.http")).unwrap(), "GET https://a\n");
    assert_eq!(std::fs::read_to_string(f.root.join("dir/inner.http")).unwrap(), "GET https://inner\n");
}

#[test]
fn delete_permanently_unlinks_files_and_folders() {
    let f = Fixture::new();

    f.h.ok("delete_permanently", json!({ "path": f.root.join("a.http") }));
    f.h.ok("delete_permanently", json!({ "path": f.root.join("dir") }));

    assert!(!f.root.join("a.http").exists() && !f.root.join("dir").exists());
    assert!(f.h.trashed().is_empty(), "nothing went through the trash");
    assert!(f.h.call("delete_permanently", json!({ "path": f.root.join("a.http") })).is_err(), "already gone");
}

#[test]
fn delete_permanently_stays_inside_the_workspace() {
    let f = Fixture::new();
    let out = tempfile::tempdir().unwrap();
    let outside = out.path().canonicalize().unwrap();
    std::fs::write(outside.join("x.http"), "GET https://x\n").unwrap();

    let err = f.h.call("delete_permanently", json!({ "path": outside.join("x.http") })).unwrap_err();
    assert!(err.as_str().unwrap().contains("outside the workspace"), "{err}");
    assert!(f.h.call("delete_permanently", json!({ "path": f.root })).is_err(), "the workspace itself can't be deleted");
    assert!(f.root.join("a.http").exists() && outside.join("x.http").exists());

    // A symlinked folder pointing outside: only the link goes.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, f.root.join("link")).unwrap();
        f.h.ok("delete_permanently", json!({ "path": f.root.join("link") }));
        assert!(std::fs::symlink_metadata(f.root.join("link")).is_err());
        assert!(outside.join("x.http").exists(), "the link's target is untouched");
    }
}

#[test]
fn watcher_ignores_our_own_deletes() {
    use std::time::Duration;
    use tauri::Listener;
    let f = Fixture::new();
    std::fs::write(f.root.join("b.http"), "GET https://b\n").unwrap();
    std::fs::create_dir(f.root.join("gone")).unwrap();
    std::fs::write(f.root.join("gone/inner.http"), "GET https://gone\n").unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    f.h.webview.listen_any("workspace-changed", move |e| {
        let _ = tx.send(e.payload().to_string());
    });
    super::changed_paths(&rx, Duration::from_millis(600));

    f.h.ok("delete_path", json!({ "path": f.root.join("a.http") }));
    f.h.ok("delete_path", json!({ "path": f.root.join("dir") }));
    f.h.ok("delete_permanently", json!({ "path": f.root.join("b.http") }));
    f.h.ok("delete_permanently", json!({ "path": f.root.join("gone") }));

    let own = super::changed_paths(&rx, Duration::from_secs(2));
    assert!(own.is_empty(), "own deletes were reported: {own:?}");
}
