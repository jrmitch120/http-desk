//! History (#151, ADR-0009): a send from a tab is recorded, with the request as sent
//! (credential headers masked), its source text, the response as received and its
//! tests, in a store under the config folder, per workspace. A Run's sends and sends
//! blocked before anything went out aren't recorded. An entry opens as a response
//! of its own, whose body is kept by id until released (ADR-0006).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::fetch::fetch;
use super::Harness;

/// Serves one response: `head` (status line and headers, without the length) and `body`.
fn answer_once(head: &'static str, body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let reply = format!("{head}\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        let _ = stream.write_all(reply.as_bytes());
    });
    url
}

/// Whether `path` is one of the History store's files (the database and its journal).
pub(super) fn is_store(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(crate::history::FILE_NAME))
}

/// A workspace holding `api.http` with `text`, opened in `h`.
fn workspace(h: &Harness, text: &str) -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("api.http"), text).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    (ws, root)
}

/// Request `i` of `root`'s `api.http`, as the webview has it.
fn request(h: &Harness, root: &Path, i: usize) -> Value {
    h.ok("read_http_file", json!({ "path": root.join("api.http") }))["requests"][i].clone()
}

/// The send of `request` from a tab, as the webview makes it.
fn send_args(root: &Path, request: &Value) -> Value {
    json!({ "runId": "t1", "request": request, "filePath": root.join("api.http"), "fileVariables": [],
            "environment": null, "requestKey": "k1", "requestNames": [] })
}

/// The History of `request` in `root`'s `api.http`, as its History view asks for it.
fn history_of(h: &Harness, root: &Path, request: &Value) -> Vec<Value> {
    let link = json!({ "filePath": root.join("api.http"), "name": name_of(request),
                       "method": request["method"], "url": request["url"] });
    h.ok("list_history", json!({ "query": { "request": link } })).as_array().unwrap().clone()
}

fn name_of(request: &Value) -> Value {
    request["directives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "name")
        .map_or(Value::Null, |d| d["value"].clone())
}

const LOGIN: &str = "### Log in
# @name login
POST {url}/login?x=1
Authorization: Bearer abc
Proxy-Authorization: Basic eHl6
Cookie: sid=s3cr3t
X-Plain: visible

{\"user\":\"jo\"}

> {%
  client.test(\"ok\", () => client.assert(response.status === 200, \"is 200\"));
%}
";

#[test]
fn a_send_from_a_tab_is_recorded_with_the_request_as_sent_its_source_response_and_tests() {
    let h = Harness::new();
    let url = answer_once(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nset-cookie: session=tok-1; Path=/",
        r#"{"token":"tok-1"}"#,
    );
    let (_ws, root) = workspace(&h, &LOGIN.replace("{url}", &url));
    h.ok("trust_workspace", json!({}));
    let login = request(&h, &root, 0);
    let sent = h.ok("send_request", send_args(&root, &login));

    let entries = history_of(&h, &root, &login);
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(
        (&entry["file"], &entry["name"], &entry["method"], &entry["url"], &entry["status"]),
        (&json!("api.http"), &json!("login"), &json!("POST"), &json!(format!("{url}/login?x=1")), &json!(200))
    );
    assert_eq!(entry["size"], sent["bodySize"]);
    assert!(entry["time"].as_str().is_some_and(|t| t.contains('T')), "{entry}");

    let opened = h.ok("open_history_entry", json!({ "id": entry["id"] }));
    let response = &opened["response"];
    assert_ne!(response["id"], sent["id"], "a response of its own");
    assert_eq!(response["status"], 200);
    // The response as received: its cookie and body hold the token, unmasked.
    assert!(response["headers"].as_array().unwrap().contains(&json!(["set-cookie", "session=tok-1; Path=/"])));
    assert_eq!(response["cookies"][0]["value"], "tok-1");
    assert_eq!(response["tests"], json!([{ "name": "ok", "passed": true, "message": null }]));
    assert_eq!(fetch(&h, &response["id"], "raw").unwrap(), br#"{"token":"tok-1"}"#);

    // The request as sent, with its credential headers masked.
    let headers = response["request"]["headers"].as_array().unwrap();
    for (name, value) in [
        ("Authorization", "••••••••"),
        ("Proxy-Authorization", "••••••••"),
        ("Cookie", "••••••••"),
        ("X-Plain", "visible"),
    ] {
        assert!(headers.contains(&json!([name, value])), "{name}: {headers:?}");
    }
    assert_eq!(response["request"]["url"], format!("{url}/login?x=1"));
    assert_eq!(response["request"]["bodyPreview"], r#"{"user":"jo"}"#);
    assert_eq!(opened["request"], response["request"]);
    // The source text as it was written at send time.
    let source = opened["source"].as_str().unwrap();
    assert!(source.starts_with("### Log in\n# @name login\nPOST "), "{source}");
    assert!(source.contains("client.test(\"ok\""), "{source}");

    h.ok("release_response", json!({ "responseId": response["id"] }));
    assert_eq!(fetch(&h, &response["id"], "raw").unwrap_err(), json!("Response is no longer available"));
}

/// The names of the files in `dir`, sorted.
fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn each_workspace_keeps_its_own_history_in_the_config_folder_across_reopening_and_a_restart() {
    let h = Harness::new();
    let (url_a, url_b) = (
        answer_once("HTTP/1.1 200 OK\r\ncontent-type: text/plain", "a"),
        answer_once("HTTP/1.1 201 Created\r\ncontent-type: text/plain", "b"),
    );
    let (_ws_a, root_a) = workspace(&h, &format!("GET {url_a}/a\n"));
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 0)));
    let (_ws_b, root_b) = workspace(&h, &format!("GET {url_b}/b\n"));
    assert_eq!(all_history(&h), Vec::<Value>::new(), "a new workspace starts with no History");
    h.ok("send_request", send_args(&root_b, &request(&h, &root_b, 0)));

    h.ok("open_workspace", json!({ "path": root_a }));
    let urls = |h: &Harness| all_history(h).iter().map(|e| e["url"].clone()).collect::<Vec<_>>();
    assert_eq!(urls(&h), [json!(format!("{url_a}/a"))]);

    let h = h.restart();
    h.ok("open_workspace", json!({ "path": root_b }));
    assert_eq!(urls(&h), [json!(format!("{url_b}/b"))]);
    let opened = h.ok("open_history_entry", json!({ "id": all_history(&h)[0]["id"] }));
    assert_eq!(fetch(&h, &opened["response"]["id"], "raw").unwrap(), b"b");

    assert!(files_in(&h.config_dir()).contains(&"history.sqlite3".to_string()), "{:?}", files_in(&h.config_dir()));
    assert_eq!(files_in(&root_a), ["api.http"], "nothing is written in the workspace");
    assert_eq!(files_in(&root_b), ["api.http"]);
}

#[test]
fn a_named_requests_history_survives_editing_its_url_and_an_unnamed_one_follows_its_method_and_url() {
    let h = Harness::new();
    let server = super::keep_alive_server(3);
    let (_ws, root) = workspace(&h, &format!("# @name pets\nGET {server}/pets\n\n###\nGET {server}/owners\n"));
    let pets = request(&h, &root, 0);
    let owners = request(&h, &root, 1);
    h.ok("send_request", send_args(&root, &pets));
    h.ok("send_request", send_args(&root, &owners));

    // Unsaved edits to the URL, then sent again.
    let mut edited = pets.clone();
    edited["url"] = json!(format!("{server}/pets?page=2"));
    h.ok("send_request", send_args(&root, &edited));

    let urls = |r: &Value| history_of(&h, &root, r).iter().map(|e| e["url"].clone()).collect::<Vec<_>>();
    assert_eq!(urls(&edited), [json!(format!("{server}/pets?page=2")), json!(format!("{server}/pets"))]);
    assert_eq!(urls(&owners), [json!(format!("{server}/owners"))]);
    let mut moved = owners.clone();
    moved["url"] = json!(format!("{server}/people"));
    assert_eq!(urls(&moved), Vec::<Value>::new(), "an unnamed request is its method and URL");
}

/// Every entry of the open workspace, newest first.
fn all_history(h: &Harness) -> Vec<Value> {
    h.ok("list_history", json!({ "query": {} })).as_array().unwrap().clone()
}

#[test]
fn network_errors_timeouts_and_cancels_are_recorded_with_the_request_that_went_out() {
    let h = Harness::new();
    let refused = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let slow = super::trickle_server(4, 2, Duration::from_secs(2));
    let hanging = super::trickle_server(4, 2, Duration::from_secs(5));
    let text = format!(
        "GET http://127.0.0.1:{refused}/refused\nAuthorization: Bearer abc\n\n###\n# @timeout 200 ms\nGET {slow}/slow\n\n###\nGET {hanging}/hang\n"
    );
    let (_ws, root) = workspace(&h, &text);

    let err = h.call("send_request", send_args(&root, &request(&h, &root, 0))).unwrap_err();
    assert_eq!(err["kind"], "refused");
    let err = h.call("send_request", send_args(&root, &request(&h, &root, 1))).unwrap_err();
    assert_eq!(err["kind"], "timeoutIdle", "{err}");
    let webview = h.webview.clone();
    let args = send_args(&root, &request(&h, &root, 2));
    let send = std::thread::spawn(move || super::call_on(&webview, "send_request", args));
    std::thread::sleep(Duration::from_millis(300));
    h.ok("cancel_request", json!({ "runId": "t1" }));
    assert_eq!(send.join().unwrap().unwrap_err()["message"], "Request cancelled");

    let entries = all_history(&h);
    let shown: Vec<(&Value, &Value, &Value)> =
        entries.iter().map(|e| (&e["url"], &e["status"], &e["cancelled"])).collect();
    assert_eq!(
        shown,
        [
            (&json!(format!("{hanging}/hang")), &Value::Null, &json!(true)),
            (&json!(format!("{slow}/slow")), &Value::Null, &json!(false)),
            (&json!(format!("http://127.0.0.1:{refused}/refused")), &Value::Null, &json!(false)),
        ]
    );
    assert!(entries[1]["error"].as_str().unwrap().starts_with("Read timeout"), "{}", entries[1]);

    let refused = h.ok("open_history_entry", json!({ "id": entries[2]["id"] }));
    assert_eq!(refused["response"], Value::Null);
    assert_eq!(refused["sendError"]["kind"], "refused");
    assert!(refused["request"]["headers"].as_array().unwrap().contains(&json!(["Authorization", "••••••••"])));
}

#[test]
fn a_runs_sends_and_sends_blocked_before_anything_went_out_are_not_recorded() {
    let h = Harness::new();
    let url = answer_once("HTTP/1.1 200 OK\r\ncontent-type: text/plain", "ok");
    let text = format!(
        "GET {url}/run\n\n###\nGET {url}/me\nX-Token: {{{{login.response.body.$.token}}}}\n\n###\nGET {url}/handled\n\n> {{%\n  client.log(1);\n%}}\n"
    );
    let (_ws, root) = workspace(&h, &text);
    let path = root.join("api.http");
    let selection =
        json!({ "requests": [{ "request": request(&h, &root, 0), "filePath": path }], "environment": null });

    h.ok("run_requests", json!({ "runId": "run1", "selection": selection }));
    // An unsent Request variable, and a script in an untrusted workspace.
    let mut me = send_args(&root, &request(&h, &root, 1));
    me["requestNames"] = json!(["login"]);
    assert_eq!(h.call("send_request", me).unwrap_err()["kind"], "unsentRequest");
    let err = h.call("send_request", send_args(&root, &request(&h, &root, 2))).unwrap_err();
    assert_eq!(err["kind"], "untrustedWorkspace", "{err}");

    assert_eq!(all_history(&h), Vec::<Value>::new());
}
