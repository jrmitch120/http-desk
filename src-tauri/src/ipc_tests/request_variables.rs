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

#[test]
fn named_exchanges_lists_each_latest_exchange_and_removing_one_makes_it_unsent_again() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (_ws, login, me) = chained_workspace(&h, &login_url, "http://127.0.0.1:9");
    assert_eq!(h.ok("named_exchanges", json!({})), json!([]));
    h.ok("send_request", login.clone());

    let list = h.ok("named_exchanges", json!({}));
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list[0]["file"], login["filePath"]);
    assert_eq!(list[0]["name"], "login");
    assert_eq!(list[0]["status"], 200);
    assert!(list[0]["received"].as_str().unwrap().ends_with('Z'), "{list}");

    let entry = json!({ "filePath": login["filePath"], "name": "login" });
    assert_eq!(h.ok("remove_named_exchange", entry.clone()), json!(true));
    assert_eq!(h.ok("named_exchanges", json!({})), json!([]));
    assert_eq!(h.ok("preview_request", me)["error"]["kind"], "unsentRequest");
    assert_eq!(h.ok("remove_named_exchange", entry), json!(false));
}

#[test]
fn clearing_named_exchanges_forgets_them_all_but_keeps_the_rest_of_the_session() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (_ws, login, me) = chained_workspace(&h, &login_url, "http://127.0.0.1:9");
    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "123456" } }));
    h.ok("send_request", login);

    h.ok("clear_named_exchanges", json!({}));

    assert_eq!(h.ok("named_exchanges", json!({})), json!([]));
    assert_eq!(h.ok("preview_request", me)["error"]["kind"], "unsentRequest");
    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k1" })), json!({ "otp": "123456" }));
}

#[test]
fn an_opened_exchange_is_a_response_of_its_own_whose_body_outlives_the_tabs() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (_ws, login, _) = chained_workspace(&h, &login_url, "http://127.0.0.1:9");
    let sent = h.ok("send_request", login.clone());
    let entry = json!({ "filePath": login["filePath"], "name": "login" });

    let opened = h.ok("open_exchange", entry.clone());

    assert_ne!(opened["id"], sent["id"], "its own id, so releasing either leaves the other");
    assert_eq!(opened["status"], 200);
    assert_eq!(opened["url"], sent["url"]);
    assert_eq!(opened["request"], sent["request"]);
    h.ok("release_response", json!({ "responseId": sent["id"] }));
    let body = super::fetch::fetch(&h, &opened["id"], "raw").unwrap();
    assert_eq!(String::from_utf8(body).unwrap(), r#"{"token":"abc123"}"#);

    h.ok("remove_named_exchange", entry.clone());
    assert!(h.call("open_exchange", entry).is_err(), "nothing to open");
}

#[test]
fn a_request_variable_reads_its_value_and_source_for_the_hover() {
    let h = Harness::new();
    let (login_url, _) = json_server(r#"{"token":"abc123"}"#);
    let (_ws, login, _) = chained_workspace(&h, &login_url, "http://127.0.0.1:9");
    let read =
        |reference: &str| h.ok("request_variable", json!({ "filePath": login["filePath"], "reference": reference }));
    assert_eq!(read("login.response.body.$.token"), json!({ "state": "unsent", "request": "login" }));
    assert_eq!(read("baseUrl"), Value::Null, "not a Request variable");

    h.ok("send_request", login.clone());
    let received = h.ok("named_exchanges", json!({}))[0]["received"].clone();

    let value = read("login.response.body.$.token");
    assert_eq!(
        value,
        json!({ "state": "value", "request": "login", "status": 200, "received": received, "value": "abc123" })
    );
    let unmatched = read("login.response.body.$.tok");
    assert_eq!(unmatched["state"], "unmatched");
    assert_eq!(unmatched["reason"], "`$.tok` matches nothing");
    assert_eq!(unmatched["received"], received);
}
