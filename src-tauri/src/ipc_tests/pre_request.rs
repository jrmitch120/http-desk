//! #140: pre-request scripts run before the request is built, only in a Trusted
//! workspace. `request.variables.set` values reach `{{name}}`,
//! `request.environment.get` reads the selected environment (private values
//! included), and a failing script sends nothing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::{json_server, Harness};

/// A workspace holding `api.http` (a GET to `url` after `script`) and a `dev`
/// environment whose `secret` is in the private file, opened in `h`.
fn workspace(h: &Harness, url: &str, script: &str) -> (tempfile::TempDir, PathBuf, Value) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("http-client.env.json"), r#"{"dev": {"user": "ada"}}"#).unwrap();
    std::fs::write(root.join("http-client.private.env.json"), r#"{"dev": {"secret": "s3cr3t"}}"#).unwrap();
    let path = root.join("api.http");
    std::fs::write(&path, format!("### Signed\n{script}\nGET {url}/\nX-Signature: {{{{signature}}}}\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let request = h.ok("read_http_file", json!({ "path": path }))["requests"][0].clone();
    (ws, root, request)
}

const SIGNS: &str = "< {%\n  request.variables.set(\"signature\", request.environment.get(\"user\") + \":\" + request.environment.get(\"secret\"));\n%}";

fn send(h: &Harness, root: &Path, request: &Value, skip_scripts: Option<bool>) -> Result<Value, Value> {
    h.call(
        "send_request",
        json!({ "runId": "p1", "request": request, "filePath": root.join("api.http"), "fileVariables": [],
                "environment": "dev", "skipScripts": skip_scripts }),
    )
}

/// The `X-Signature` header the server received.
fn received_signature(raw: &str) -> Option<&str> {
    raw.lines().find_map(|l| l.strip_prefix("x-signature: ").or_else(|| l.strip_prefix("X-Signature: ")))
}

#[test]
fn a_pre_request_script_in_an_untrusted_workspace_is_refused_before_anything_is_sent() {
    let h = Harness::new();
    let (url, received) = json_server("{}");
    let (_ws, root, request) = workspace(&h, &url, SIGNS);
    let e = send(&h, &root, &request, None).unwrap_err();
    assert_eq!(e["kind"], "untrustedWorkspace", "{e}");
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing was sent");
}

#[test]
fn a_trusted_workspace_sends_the_header_the_script_built_from_a_private_environment_value() {
    let h = Harness::new();
    let (url, received) = json_server("{}");
    let (_ws, root, request) = workspace(&h, &url, SIGNS);
    h.ok("trust_workspace", json!({}));
    let response = send(&h, &root, &request, None).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["warnings"], json!([]));
    let raw = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(received_signature(&raw), Some("ada:s3cr3t"), "{raw}");
}

#[test]
fn a_failing_pre_request_script_sends_nothing_and_reports_its_line_and_message() {
    let h = Harness::new();
    let (url, received) = json_server("{}");
    let script = "< {%\n  request.variables.set(\"signature\", \"x\");\n  sign(request);\n%}";
    let (_ws, root, request) = workspace(&h, &url, script);
    h.ok("trust_workspace", json!({}));
    let e = send(&h, &root, &request, None).unwrap_err();
    assert_eq!(
        e,
        json!({ "kind": "preRequestScript", "message": "ReferenceError: sign is not defined (line 3)",
                "details": { "line": 3 } })
    );
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing was sent");
}

#[test]
fn sending_without_scripts_skips_the_pre_request_script_and_says_so() {
    let h = Harness::new();
    let (url, received) = json_server("{}");
    let (_ws, root, request) = workspace(&h, &url, SIGNS);
    let response = send(&h, &root, &request, Some(true)).unwrap();
    assert_eq!(
        response["warnings"],
        json!(["Undefined variables: signature", "Sent without scripts: the pre-request script didn't run."])
    );
    let raw = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(received_signature(&raw), Some("{{signature}}"), "{raw}");
}

#[test]
fn the_preview_never_runs_the_pre_request_script() {
    let h = Harness::new();
    let (url, received) = json_server("{}");
    let (_ws, root, request) = workspace(&h, &url, SIGNS);
    h.ok("trust_workspace", json!({}));
    let preview = h.ok(
        "preview_request",
        json!({ "request": request, "filePath": root.join("api.http"), "fileVariables": [], "environment": "dev" }),
    );
    assert_eq!(preview["headers"][0], json!(["X-Signature", "{{signature}}"]));
    let warnings = preview["warnings"].as_array().unwrap();
    assert!(warnings.contains(&json!(httpdesk_core::exec::PRE_REQUEST_NOT_PREVIEWED)), "{warnings:?}");
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err());
}
