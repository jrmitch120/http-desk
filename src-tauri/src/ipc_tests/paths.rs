//! Workspace paths as users know them, and the commands moved off the main
//! thread (they must still answer over IPC exactly as before).
//!
//! The workspace is opened with the path as a folder dialog returns it, not
//! pre-canonicalized. On macOS the temp dir sits behind the `/var` symlink; on
//! Windows, std's canonical form would add a `\\?\` prefix.

use serde_json::{json, Value};

use super::{capture_server, Harness};

fn no_verbatim_prefix(v: &Value) {
    let s = v.as_str().unwrap();
    assert!(!s.starts_with(r"\\?\"), "verbatim path leaked to the UI: {s}");
}

#[test]
fn open_workspace_returns_and_remembers_a_normal_canonical_path() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let info = h.ok("open_workspace", json!({ "path": ws.path() }));
    no_verbatim_prefix(&info["root"]);
    assert_eq!(info["root"], json!(crate::paths::canonicalize(ws.path()).unwrap()));

    let settings = h.ok("get_settings", json!({}));
    assert_eq!(settings["recentWorkspaces"][0], info["root"]);
}

#[test]
fn openapi_environments_land_in_the_workspace_root_for_a_dialog_picked_folder() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    h.ok("open_workspace", json!({ "path": ws.path() }));
    let spec = root.join("spec.yaml");
    std::fs::write(
        &spec,
        "openapi: 3.0.3\ninfo: {title: Mini, version: '1'}\nservers: [{url: 'https://api.mini.dev'}]\npaths:\n  /ping:\n    get:\n      operationId: ping\n      responses: {'200': {description: ok}}\n",
    )
    .unwrap();
    let source = spec.to_string_lossy().to_string();
    h.ok("openapi_load", json!({ "source": source }));

    std::fs::create_dir(root.join("generated")).unwrap();
    let report = h.ok(
        "openapi_generate",
        json!({ "source": source, "options": { "operationIds": [], "grouping": "single", "baseUrlVariable": "baseUrl", "singleFileName": "api" },
                "outputDir": ws.path().join("generated"), "overwrite": false, "dryRun": false }),
    );
    assert_eq!(report["written"], true);
    no_verbatim_prefix(&report["envDir"]);
    assert_eq!(report["envDir"], json!(root));
    no_verbatim_prefix(&report["files"][0]);
    let env = std::fs::read_to_string(root.join("http-client.env.json")).unwrap();
    assert!(env.contains("https://api.mini.dev"), "{env}");
    assert!(!root.join("generated/http-client.env.json").exists());
}

#[test]
fn search_tree_and_response_body_commands_answer_over_ipc() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, _received) = capture_server();
    std::fs::write(root.join("a.http"), format!("### Ping\nGET {server}/ping\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    assert_eq!(h.ok("get_tree", json!({}))["children"][0]["name"], "a.http");
    assert_eq!(h.ok("search_requests", json!({ "query": "ping" }))[0]["name"], "Ping");

    let file = h.ok("read_http_file", json!({ "path": root.join("a.http") }));
    let resp = h.ok(
        "send_request",
        json!({ "runId": "r1", "request": file["requests"][0], "filePath": root.join("a.http"), "fileVariables": [], "environment": null }),
    );
    // The native save dialog may point anywhere, so the target is outside the workspace.
    let out = tempfile::tempdir().unwrap();
    let target = out.path().join("body.json");
    h.ok("save_response_body", json!({ "responseId": resp["id"], "path": target }));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), r#"{"ok":true}"#);

    let err = h.call("save_response_body", json!({ "responseId": "gone", "path": target })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
}

/// Called directly: settings are read at startup from a process-wide config dir.
#[cfg(windows)]
#[test]
fn recents_saved_by_older_versions_lose_the_verbatim_prefix() {
    use std::path::PathBuf;
    let saved = [PathBuf::from(r"\\?\C:\work\api"), PathBuf::from(r"C:\work\api"), PathBuf::from(r"D:\other")];
    let recents = crate::simplified_recents(&saved);
    assert_eq!(recents, [PathBuf::from(r"C:\work\api"), PathBuf::from(r"D:\other")]);
}
