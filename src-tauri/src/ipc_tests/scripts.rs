//! #137: response handlers run only in a Trusted workspace. Trust is kept in the
//! app settings per canonical workspace path, survives a restart, can be revoked,
//! and is never lost to a page saving its (older) copy of the settings.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

use super::{json_server, Harness};

const HANDLER: &str = "> {%\n  client.test(\"ok\", () => client.assert(response.body.ok === true, \"body.ok\"));\n  client.assert(response.status === 404, \"is 404\");\n%}";

/// A workspace holding `api.http`: one GET to `url` with a response handler, opened in `h`.
fn workspace(h: &Harness, url: &str) -> (tempfile::TempDir, PathBuf, Value) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let path = root.join("api.http");
    std::fs::write(&path, format!("GET {url}/\n\n{HANDLER}\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let request = h.ok("read_http_file", json!({ "path": path }))["requests"][0].clone();
    (ws, root, request)
}

fn send(h: &Harness, root: &Path, request: &Value, skip_scripts: Option<bool>) -> Result<Value, Value> {
    h.call(
        "send_request",
        json!({ "runId": "s1", "request": request, "filePath": root.join("api.http"), "fileVariables": [],
                "environment": null, "skipScripts": skip_scripts }),
    )
}

/// The request with its handler replaced by `url`: the server changes per send.
fn to(request: &Value, url: &str) -> Value {
    let mut r = request.clone();
    r["url"] = json!(format!("{url}/"));
    r["raw"] = Value::Null;
    r
}

fn passed_and_failed() -> Value {
    json!([
        { "name": "ok", "passed": true, "message": null },
        { "name": "is 404", "passed": false, "message": "is 404" },
    ])
}

#[test]
fn a_handler_in_an_untrusted_workspace_is_refused_before_anything_is_sent() {
    let h = Harness::new();
    let (url, received) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    let e = send(&h, &root, &request, None).unwrap_err();
    assert_eq!(e["kind"], "untrustedWorkspace", "{e}");
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing was sent");
}

#[test]
fn sending_without_scripts_sends_and_skips_the_handler() {
    let h = Harness::new();
    let (url, received) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    let response = send(&h, &root, &request, Some(true)).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["tests"], json!([]));
    assert_eq!(response["logs"], json!([]));
    assert_eq!(response["warnings"], json!(["Sent without scripts: the response handler didn't run."]));
    assert!(received.recv_timeout(Duration::from_secs(2)).is_ok());
}

#[test]
fn a_trusted_workspace_runs_the_handler_and_the_response_carries_its_tests() {
    let h = Harness::new();
    let (url, _received) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    let trusted = h.ok("trust_workspace", json!({}));
    assert_eq!(trusted, json!([root.to_string_lossy()]));
    let response = send(&h, &root, &request, None).unwrap();
    assert_eq!(response["tests"], passed_and_failed());
    let body = super::fetch::fetch(&h, &response["id"], "raw").unwrap();
    assert_eq!(body, br#"{"ok":true}"#, "the body is still kept for the viewer");
}

#[test]
fn a_request_without_scripts_never_needs_trust() {
    let h = Harness::new();
    let (url, _received) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    let mut plain = request.clone();
    plain["responseHandler"] = Value::Null;
    plain["raw"] = Value::Null;
    let response = send(&h, &root, &plain, None).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["tests"], json!([]));
    assert_eq!(response["warnings"], json!([]));
}

#[test]
fn trust_survives_a_restart_and_can_be_revoked() {
    let h = Harness::new();
    let (url, _) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    h.ok("trust_workspace", json!({}));

    // A restart: the defaults, then whatever settings.json holds.
    *h.app.state::<crate::AppState>().settings.lock().unwrap() = crate::AppSettings::default();
    crate::load_settings(h.app.handle());
    let key = root.to_string_lossy().to_string();
    assert_eq!(h.ok("get_settings", json!({}))["trustedWorkspaces"], json!([key]));
    let (url, _) = json_server(r#"{"ok":true}"#);
    assert_eq!(send(&h, &root, &to(&request, &url), None).unwrap()["tests"], passed_and_failed());

    let left = h.ok("revoke_workspace_trust", json!({ "path": key }));
    assert_eq!(left, json!([]));
    *h.app.state::<crate::AppState>().settings.lock().unwrap() = crate::AppSettings::default();
    crate::load_settings(h.app.handle());
    assert_eq!(h.ok("get_settings", json!({}))["trustedWorkspaces"], json!([]));
    let (url, _) = json_server(r#"{"ok":true}"#);
    assert_eq!(send(&h, &root, &to(&request, &url), None).unwrap_err()["kind"], "untrustedWorkspace");
}

#[test]
fn a_page_saving_older_settings_keeps_the_trust_the_shell_stored() {
    let h = Harness::new();
    let (url, _) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    let mut stale = h.ok("get_settings", json!({}));
    h.ok("trust_workspace", json!({}));
    stale["theme"] = json!("dark");
    h.ok("save_settings", json!({ "settings": stale }));

    let settings = h.ok("get_settings", json!({}));
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["trustedWorkspaces"], json!([root.to_string_lossy()]));
    *h.app.state::<crate::AppState>().settings.lock().unwrap() = crate::AppSettings::default();
    crate::load_settings(h.app.handle());
    assert_eq!(h.ok("get_settings", json!({}))["trustedWorkspaces"], json!([root.to_string_lossy()]));
    assert_eq!(send(&h, &root, &request, None).unwrap()["tests"], passed_and_failed());
}

#[test]
fn trust_is_never_written_into_the_workspace() {
    let h = Harness::new();
    let (url, _) = json_server(r#"{"ok":true}"#);
    let (_ws, root, _request) = workspace(&h, &url);
    h.ok("trust_workspace", json!({}));
    let names: Vec<String> =
        std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["api.http"]);
}

#[test]
fn the_response_carries_what_its_handler_logged() {
    let h = Harness::new();
    let (url, _) = json_server(r#"{"ok":true}"#);
    let (_ws, root, request) = workspace(&h, &url);
    h.ok("trust_workspace", json!({}));
    let mut logging = request.clone();
    logging["responseHandler"] =
        json!("> {%\n  client.log(\"status\", response.status);\n  client.log(response.body);\n%}");
    logging["raw"] = Value::Null;
    let response = send(&h, &root, &logging, None).unwrap();
    assert_eq!(response["logs"], json!(["status 200", r#"{"ok":true}"#]));
    assert_eq!(response["tests"], json!([]));
}
