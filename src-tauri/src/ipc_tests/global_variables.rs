//! Global variables over IPC: a response handler's `client.global.set` in a trusted
//! workspace reaches `{{name}}` in a request of another file, and the Session panel's
//! Global variables section lists them, deletes one and clears them all. Clear session
//! clears them, another workspace starts with none, and none is ever written to disk.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::{capture_server, json_server, Harness};

/// A workspace in a temporary folder, open and trusted.
fn trusted_workspace(h: &Harness) -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    h.ok("trust_workspace", json!({}));
    (ws, root)
}

/// Writes `text` to `name` in `root` and sends its first request.
fn send(h: &Harness, root: &Path, name: &str, text: &str) -> Value {
    let path = root.join(name);
    std::fs::write(&path, text).unwrap();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let args = json!({ "runId": name, "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null });
    h.ok("send_request", args)
}

/// Sends a login whose handler stores the response's token as the Global variable `token`.
fn log_in(h: &Harness, root: &Path) {
    let (url, received) = json_server(r#"{"token":"s3cret-token"}"#);
    let login = format!("POST {url}/login\n\n> {{% client.global.set(\"token\", response.body.token) %}}\n");
    let response = send(h, root, "auth.http", &login);
    assert_eq!(response["tests"], json!([]), "{response}");
    received.recv_timeout(Duration::from_secs(5)).unwrap();
}

/// Sends `GET /me` with `{{token}}` from another file, returning the raw request.
fn send_me(h: &Harness, root: &Path) -> String {
    let (url, received) = capture_server();
    send(h, root, "api/users.http", &format!("GET {url}/me\nAuthorization: Bearer {{{{token}}}}\n"));
    received.recv_timeout(Duration::from_secs(5)).unwrap().to_ascii_lowercase()
}

fn listed(h: &Harness) -> Value {
    h.ok("session_globals", json!({}))
}

#[test]
fn a_token_logins_handler_stores_is_sent_from_another_file_and_listed() {
    let h = Harness::new();
    let (_ws, root) = trusted_workspace(&h);
    std::fs::create_dir(root.join("api")).unwrap();

    log_in(&h, &root);

    assert_eq!(listed(&h), json!([{ "name": "token", "value": "s3cret-token" }]));
    let raw = send_me(&h, &root);
    assert!(raw.contains("authorization: bearer s3cret-token"), "{raw}");
}

#[test]
fn a_deleted_global_variable_is_undefined_again_and_clearing_deletes_them_all() {
    let h = Harness::new();
    let (_ws, root) = trusted_workspace(&h);
    std::fs::create_dir(root.join("api")).unwrap();
    log_in(&h, &root);
    let (url, received) = capture_server();
    send(&h, &root, "more.http", &format!("GET {url}/\n\n> {{% client.global.set(\"a\", \"1\"); %}}\n"));
    received.recv_timeout(Duration::from_secs(5)).unwrap();

    assert_eq!(h.ok("delete_global", json!({ "name": "token" })), json!(true));
    assert_eq!(h.ok("delete_global", json!({ "name": "token" })), json!(false));
    assert_eq!(listed(&h), json!([{ "name": "a", "value": "1" }]));
    let raw = send_me(&h, &root);
    assert!(raw.contains("authorization: bearer {{token}}"), "{raw}");

    h.ok("clear_globals", json!({}));
    assert_eq!(listed(&h), json!([]));
}

#[test]
fn clear_session_and_another_workspace_start_with_no_global_variables_and_none_is_written() {
    let h = Harness::new();
    let (first, root) = trusted_workspace(&h);
    log_in(&h, &root);
    h.ok("clear_session", json!({}));
    assert_eq!(listed(&h), json!([]));

    log_in(&h, &root);
    let (second, _other) = trusted_workspace(&h);
    assert_eq!(listed(&h), json!([]), "the new workspace's Session started with the old Global variables");

    for dir in [first.path(), second.path(), h.config_dir().as_path()] {
        for entry in walk(dir) {
            let content = String::from_utf8_lossy(&std::fs::read(&entry).unwrap_or_default()).into_owned();
            assert!(!content.contains("s3cret-token"), "{} holds a Global variable", entry.display());
        }
    }
}

/// Every file under `dir`.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}
