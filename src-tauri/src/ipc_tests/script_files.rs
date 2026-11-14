//! #142: script file references (`< sign.js`, `> check.js`) are read relative to
//! the `.http` file and only from inside the workspace; the Scripts editor checks
//! them and opens them in the default editor; `>> file` redirects aren't run.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

use super::{json_server, Harness};

/// A trusted workspace `<tmp>/ws` holding `api/calls.http` (a GET to `url`, with
/// `scripts` around it as the `.http` file has them), opened in `h`. `<tmp>` is
/// outside the workspace.
fn workspace(h: &Harness, url: &str, pre: &str, handler: &str) -> (tempfile::TempDir, PathBuf, Value) {
    let outer = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(outer.path()).unwrap().join("ws");
    std::fs::create_dir_all(root.join("api")).unwrap();
    let path = root.join("api/calls.http");
    std::fs::write(&path, format!("### Call\n{pre}\nGET {url}/\n\n{handler}\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    h.ok("trust_workspace", json!({}));
    let request = h.ok("read_http_file", json!({ "path": path }))["requests"][0].clone();
    (outer, root, request)
}

fn send(h: &Harness, root: &Path, request: &Value) -> Result<Value, Value> {
    h.call(
        "send_request",
        json!({ "runId": "f1", "request": request, "filePath": root.join("api/calls.http"), "fileVariables": [],
                "environment": null }),
    )
}

#[test]
fn a_handler_file_next_to_the_http_file_runs_and_its_tests_show() {
    let h = Harness::new();
    let (url, _received) = json_server(r#"{"ok":true}"#);
    let (_outer, root, request) = workspace(&h, &url, "", "> check.js");
    std::fs::write(root.join("api/check.js"), "client.test(\"ok\", () => client.assert(response.body.ok, \"ok\"));")
        .unwrap();
    let response = send(&h, &root, &request).unwrap();
    assert_eq!(response["tests"], json!([{ "name": "ok", "passed": true, "message": null }]));
}

#[test]
fn a_handler_file_outside_the_workspace_is_a_failed_test_and_the_request_is_still_sent() {
    let h = Harness::new();
    let (url, received) = json_server(r#"{"ok":true}"#);
    let (outer, root, request) = workspace(&h, &url, "", "> ../../outside.js");
    std::fs::write(outer.path().join("outside.js"), "client.test(\"ran\", () => {});").unwrap();
    let response = send(&h, &root, &request).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(
        response["tests"],
        json!([{ "name": "Response handler", "passed": false,
                 "message": "Script file ../../outside.js is outside the workspace" }])
    );
    assert!(received.recv_timeout(Duration::from_secs(2)).is_ok());
}

#[test]
fn a_missing_pre_request_script_file_blocks_the_send() {
    let h = Harness::new();
    let (url, received) = json_server(r#"{"ok":true}"#);
    let (_outer, root, request) = workspace(&h, &url, "< ./sign.js", "");
    let e = send(&h, &root, &request).unwrap_err();
    assert_eq!(e["kind"], "preRequestScript", "{e}");
    assert_eq!(e["message"], "Script file ./sign.js doesn't exist");
    assert_eq!(e["details"], json!({ "line": null }));
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing was sent");

    std::fs::write(root.join("api/sign.js"), "request.variables.set(\"n\", \"1\");").unwrap();
    send(&h, &root, &request).unwrap();
}

#[test]
fn a_response_redirect_sends_normally_writes_no_file_and_says_so() {
    let h = Harness::new();
    let (url, received) = json_server(r#"{"ok":true}"#);
    let (outer, root, request) = workspace(&h, &url, "", ">> out.json");
    let response = send(&h, &root, &request).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(
        response["warnings"],
        json!(["HttpDesk doesn't run response redirects: >> out.json doesn't save the response to a file."])
    );
    assert!(received.recv_timeout(Duration::from_secs(2)).is_ok());
    let mut written: Vec<PathBuf> = Vec::new();
    let mut dirs = vec![outer.path().to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path.clone());
            }
            written.push(path);
        }
    }
    assert!(!written.iter().any(|p| p.ends_with("out.json")), "{written:?}");
}

/// Records what the opener is asked to open, instead of opening it.
fn recording_opener(h: &Harness) -> Arc<Mutex<Vec<PathBuf>>> {
    let opened = Arc::new(Mutex::new(Vec::new()));
    let record = opened.clone();
    h.app.state::<crate::AppState>().opener.replace(move |path| {
        record.lock().unwrap().push(path.to_path_buf());
        Ok(())
    });
    opened
}

fn args(root: &Path, path: &str) -> Value {
    json!({ "filePath": root.join("api/calls.http"), "path": path })
}

#[test]
fn a_script_file_is_checked_and_opened_only_inside_the_workspace() {
    let h = Harness::new();
    let opened = recording_opener(&h);
    let (outer, root, _) = workspace(&h, "http://127.0.0.1:9", "", "> check.js");
    std::fs::write(root.join("api/check.js"), "").unwrap();
    std::fs::write(outer.path().join("outside.js"), "").unwrap();

    assert_eq!(h.ok("check_script_file", args(&root, "check.js")), Value::Null);
    h.ok("open_script_file", args(&root, "./check.js"));
    assert_eq!(*opened.lock().unwrap(), [root.join("api/check.js")]);

    for (path, message) in [
        ("../../outside.js", "Script file ../../outside.js is outside the workspace"),
        ("missing.js", "Script file missing.js doesn't exist"),
    ] {
        assert_eq!(h.call("check_script_file", args(&root, path)).unwrap_err(), json!(message));
        assert_eq!(h.call("open_script_file", args(&root, path)).unwrap_err(), json!(message));
    }
    assert_eq!(opened.lock().unwrap().len(), 1, "nothing else was opened");
}

#[test]
fn only_a_js_file_is_opened_so_opening_never_runs_a_program() {
    let h = Harness::new();
    let opened = recording_opener(&h);
    let (_outer, root, _) = workspace(&h, "http://127.0.0.1:9", "< ./run.command", "");
    std::fs::write(root.join("api/run.command"), "#!/bin/sh\n").unwrap();
    let e = h.call("open_script_file", args(&root, "./run.command")).unwrap_err();
    assert_eq!(e, json!("Only .js script files can be opened from HttpDesk"));
    assert!(opened.lock().unwrap().is_empty());
}
