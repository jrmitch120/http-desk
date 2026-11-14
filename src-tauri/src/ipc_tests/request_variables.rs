//! Request variables over IPC: a send of a `# @name` request records its exchange in
//! the workspace Session; a later request in the same file reads it in the preview
//! and the send. A request variable of a request not sent yet blocks the send with
//! its own report, and nothing is sent on its own.

use std::time::Duration;

use serde_json::{json, Value};

use super::{capture_server, json_server, Harness};

/// A workspace whose `api.http` has `login` (answered by `login_url`) and a request
/// sending its token to `me_url`. Returns the args of each request's send.
fn chained_workspace(h: &Harness, login_url: &str, me_url: &str) -> (tempfile::TempDir, Value, Value) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let file_path = root.join("api.http");
    let text = format!(
        "# @name login\nPOST {login_url}/login\n\n###\nGET {me_url}/me\nX-Token: {{{{login.response.body.$.token}}}}\n"
    );
    std::fs::write(&file_path, text).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let args = |i: usize| {
        json!({
            "request": file["requests"][i], "filePath": path, "fileVariables": [], "environment": null,
            "requestKey": format!("k{i}"), "requestNames": ["login"], "runId": format!("r{i}"),
        })
    };
    (ws, args(0), args(1))
}

#[test]
fn a_request_variable_reads_the_named_requests_latest_exchange_in_the_preview_and_the_send() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (me_url, received) = capture_server();
    let (_ws, login, me) = chained_workspace(&h, &login_url, &me_url);

    // Not sent yet: the send is blocked with its own report, and the preview says so.
    let err = h.call("send_request", me.clone()).unwrap_err();
    assert_eq!(err["kind"], "unsentRequest", "{err}");
    assert_eq!(err["details"], json!({ "names": ["login"] }));
    assert!(received.try_recv().is_err(), "nothing was sent");
    assert_eq!(h.ok("preview_request", me.clone())["error"]["kind"], "unsentRequest");

    h.ok("send_request", login);
    let shown = h.ok("preview_request", me.clone());
    assert_eq!(shown["error"], Value::Null);
    assert!(shown["headers"].as_array().unwrap().contains(&json!(["X-Token", "abc123"])), "{shown}");

    h.ok("send_request", me);
    let raw = received.recv_timeout(Duration::from_secs(5)).unwrap().to_ascii_lowercase();
    assert!(raw.contains("x-token: abc123"), "{raw}");
}

#[test]
fn opening_another_workspace_forgets_every_exchange() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (first, login, me) = chained_workspace(&h, &login_url, "http://127.0.0.1:9");
    h.ok("send_request", login);
    assert_eq!(h.ok("preview_request", me.clone())["error"], Value::Null);

    let other = tempfile::tempdir().unwrap();
    h.ok("open_workspace", json!({ "path": other.path() }));
    h.ok("open_workspace", json!({ "path": first.path() }));

    assert_eq!(h.ok("preview_request", me)["error"]["kind"], "unsentRequest");
}
