//! History (#151, ADR-0009): a send from a tab is recorded, with the request as sent
//! (credential headers, Secret values and prompt answers masked: #153), its source
//! text, the response as received and its tests, in a store under the config folder,
//! per workspace. A Run's sends and sends
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

/// Answers every request with `200 ok`, one per connection, on any number of connections.
fn answer_each() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().map_while(Result::ok) {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 2\r\n\r\nok");
        }
    });
    url
}

/// Whether `path` is one of the History store's files (the database and its journal).
pub(super) fn is_store(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(crate::history::FILE_NAME))
}

/// A workspace holding `api.http` with `text`, opened in `h`.
pub(super) fn workspace(h: &Harness, text: &str) -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("api.http"), text).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    (ws, root)
}

/// Request `i` of `root`'s `api.http`, as the webview has it.
pub(super) fn request(h: &Harness, root: &Path, i: usize) -> Value {
    h.ok("read_http_file", json!({ "path": root.join("api.http") }))["requests"][i].clone()
}

/// The send of `request` from a tab, as the webview makes it.
pub(super) fn send_args(root: &Path, request: &Value) -> Value {
    json!({ "runId": "t1", "request": request, "filePath": root.join("api.http"), "fileVariables": [],
            "environment": null, "requestKey": "k1", "requestNames": [] })
}

/// The History of `request` in `root`'s `api.http`, as its History view asks for it.
pub(super) fn history_of(h: &Harness, root: &Path, request: &Value) -> Vec<Value> {
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

const WITH_VARIABLES: &str = "### Make pet
# @name makePet
@kind = dog
@token = t0k3n
POST {url}/{{kind}}s
Authorization: Bearer {{token}}

{\"kind\": \"{{kind}}\"}
";

#[test]
fn an_entrys_source_text_parses_back_into_its_request_with_its_variables_as_written() {
    let h = Harness::new();
    let url = answer_once("HTTP/1.1 201 Created", "");
    let (_ws, root) = workspace(&h, &WITH_VARIABLES.replace("{url}", &url));
    let pet = request(&h, &root, 0);
    h.ok("send_request", send_args(&root, &pet));
    let entry = &history_of(&h, &root, &pet)[0];
    assert_eq!(entry["url"], format!("{url}/dogs"), "sent resolved");

    let source = h.ok("open_history_entry", json!({ "id": entry["id"] }))["source"].clone();
    let restored = h.ok("parse_request", json!({ "text": source }));

    assert_eq!(restored["url"], format!("{url}/{{{{kind}}}}s"));
    // The credential as written, not masked like the request as sent.
    assert_eq!((&restored["auth"]["kind"], &restored["auth"]["token"]), (&json!("bearer"), &json!("{{token}}")));
    assert_eq!(restored["body"]["text"], "{\"kind\": \"{{kind}}\"}");
    assert_eq!((&restored["name"], name_of(&restored)), (&json!("Make pet"), json!("makePet")));
    assert_eq!(h.ok("parse_request", json!({ "text": "# only a comment\n" })), Value::Null);
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
pub(super) fn all_history(h: &Harness) -> Vec<Value> {
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

/// The URLs of the open workspace's entries that `query` asks for, newest first.
fn listed(h: &Harness, query: Value) -> Vec<String> {
    let entries = h.ok("list_history", json!({ "query": query }));
    entries.as_array().unwrap().iter().map(|e| e["url"].as_str().unwrap().to_string()).collect()
}

#[test]
fn the_workspaces_history_filters_by_status_class_and_by_text_in_any_file() {
    let h = Harness::new();
    let ok = answer_once("HTTP/1.1 200 OK\r\ncontent-type: text/plain", "ok");
    let unchanged = answer_once("HTTP/1.1 304 Not Modified", "");
    let missing = answer_once("HTTP/1.1 404 Not Found\r\ncontent-type: text/plain", "no");
    let broken = answer_once("HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain", "down");
    let refused = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let text = format!(
        "# @name login\nPOST {ok}/login\n\n###\nGET {unchanged}/cached\n\n###\nGET {missing}/pets/9\n\n###\nGET http://127.0.0.1:{refused}/refused\n"
    );
    let (_ws, root) = workspace(&h, &text);
    for i in 0..4 {
        let _ = h.call("send_request", send_args(&root, &request(&h, &root, i)));
    }
    // A request in another file.
    std::fs::write(root.join("owners.http"), format!("GET {broken}/owners\n")).unwrap();
    let owners = h.ok("read_http_file", json!({ "path": root.join("owners.http") }))["requests"][0].clone();
    let mut args = send_args(&root, &owners);
    args["filePath"] = json!(root.join("owners.http"));
    h.ok("send_request", args);

    let refused = format!("http://127.0.0.1:{refused}/refused");
    assert_eq!(listed(&h, json!({ "status": "2xx" })), [format!("{ok}/login")]);
    assert_eq!(listed(&h, json!({ "status": "3xx" })), [format!("{unchanged}/cached")]);
    assert_eq!(listed(&h, json!({ "status": "4xx" })), [format!("{missing}/pets/9")]);
    assert_eq!(listed(&h, json!({ "status": "5xx" })), [format!("{broken}/owners")]);
    assert_eq!(listed(&h, json!({ "status": "error" })), std::slice::from_ref(&refused), "no response came back");

    // Text matches the URL as sent, the method, the request's file and its name, ignoring case.
    assert_eq!(listed(&h, json!({ "text": "PETS/9" })), [format!("{missing}/pets/9")]);
    assert_eq!(listed(&h, json!({ "text": "post" })), [format!("{ok}/login")]);
    assert_eq!(listed(&h, json!({ "text": "owners.http" })), [format!("{broken}/owners")]);
    assert_eq!(listed(&h, json!({ "text": "login" })), [format!("{ok}/login")]);
    // `%` and `_` are only themselves.
    assert_eq!(listed(&h, json!({ "text": "%" })), Vec::<String>::new());
    assert_eq!(listed(&h, json!({ "text": "_" })), Vec::<String>::new());
    // Both at once, and with a request.
    assert_eq!(listed(&h, json!({ "status": "error", "text": "refused" })), [refused]);
    assert_eq!(listed(&h, json!({ "status": "4xx", "text": "login" })), Vec::<String>::new());
    let login = json!({ "filePath": root.join("api.http"), "name": "login", "method": "POST", "url": "x" });
    assert_eq!(listed(&h, json!({ "request": login, "status": "2xx", "text": "LOGIN" })), [format!("{ok}/login")]);
    assert_eq!(listed(&h, json!({ "request": login, "status": "5xx" })), Vec::<String>::new());
}

#[test]
fn the_workspaces_history_comes_a_page_at_a_time_newest_first_and_filtered() {
    let h = Harness::new();
    let server = super::keep_alive_server(5);
    let text = (1..=5).map(|i| format!("GET {server}/{i}\n")).collect::<Vec<_>>().join("\n###\n");
    let (_ws, root) = workspace(&h, &text);
    for i in 0..5 {
        h.ok("send_request", send_args(&root, &request(&h, &root, i)));
    }
    let urls = |ids: &[u32]| ids.iter().map(|i| format!("{server}/{i}")).collect::<Vec<_>>();

    assert_eq!(listed(&h, json!({ "limit": 2 })), urls(&[5, 4]));
    assert_eq!(listed(&h, json!({ "offset": 2, "limit": 2 })), urls(&[3, 2]));
    assert_eq!(listed(&h, json!({ "offset": 4, "limit": 2 })), urls(&[1]));
    assert_eq!(listed(&h, json!({ "offset": 6, "limit": 2 })), Vec::<String>::new());
    // A page of the filtered list.
    assert_eq!(listed(&h, json!({ "text": "/", "status": "2xx", "offset": 1, "limit": 3 })), urls(&[4, 3, 2]));
}

/// What the History store's files hold, as text, read after every write has landed.
fn store_text(h: &Harness) -> String {
    all_history(h);
    let mut text = String::new();
    for entry in std::fs::read_dir(h.config_dir()).unwrap() {
        let path = entry.unwrap().path();
        if is_store(&path) {
            text.push_str(&String::from_utf8_lossy(&std::fs::read(&path).unwrap()));
        }
    }
    assert!(!text.is_empty(), "no History store in the config folder");
    text
}

/// The send of `request` from a tab with `environment` selected, as the webview makes it.
fn send_in(root: &Path, request: &Value, environment: &str) -> Value {
    let mut args = send_args(root, request);
    args["environment"] = json!(environment);
    args
}

/// The one entry of the open workspace, opened.
pub(super) fn the_entry(h: &Harness) -> Value {
    let entries = all_history(h);
    assert_eq!(entries.len(), 1, "{entries:?}");
    h.ok("open_history_entry", json!({ "id": entries[0]["id"] }))
}

#[test]
fn a_secret_is_masked_in_the_recorded_url_headers_and_body_and_is_nowhere_in_the_store() {
    let h = Harness::new();
    let url = answer_once("HTTP/1.1 200 OK\r\ncontent-type: text/plain", "ok");
    let text = format!(
        "POST {url}/items?key={{{{token}}}}&q=a\nX-Api-Key: {{{{token}}}}\nContent-Type: application/json\n\n{{\"token\":\"{{{{token}}}}\"}}\n"
    );
    let (_ws, root) = workspace(&h, &text);
    std::fs::write(root.join("http-client.env.json"), json!({ "local": { "token": "" } }).to_string()).unwrap();
    std::fs::write(root.join("http-client.private.env.json"), json!({ "local": { "token": "tok-7Qz9" } }).to_string())
        .unwrap();
    h.ok("send_request", send_in(&root, &request(&h, &root, 0), "local"));

    let opened = the_entry(&h);
    for request in [&opened["request"], &opened["response"]["request"]] {
        assert_eq!(request["url"], format!("{url}/items?key=••••••••&q=a"));
        assert!(request["headers"].as_array().unwrap().contains(&json!(["X-Api-Key", "••••••••"])), "{request}");
        assert_eq!(request["bodyPreview"], r#"{"token":"••••••••"}"#);
    }
    assert!(!store_text(&h).contains("tok-7Qz9"), "the store holds the Secret's value");
}

#[test]
fn prompt_answers_are_masked_in_the_recorded_request_and_are_nowhere_in_the_store() {
    let h = Harness::new();
    let url = answer_once("HTTP/1.1 200 OK\r\ncontent-type: text/plain", "ok");
    let text = format!(
        "# @prompt otp\n# @prompt password\nPOST {url}/login?otp={{{{otp}}}}\nX-Pass: {{{{password}}}}\n\notp={{{{otp}}}}&password={{{{password}}}}\n"
    );
    let (_ws, root) = workspace(&h, &text);
    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "842913", "password": "hunter two" } }));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));

    let opened = the_entry(&h);
    for request in [&opened["request"], &opened["response"]["request"]] {
        assert_eq!(request["url"], format!("{url}/login?otp=••••••••"));
        assert!(request["headers"].as_array().unwrap().contains(&json!(["X-Pass", "••••••••"])), "{request}");
        assert_eq!(request["bodyPreview"], "otp=••••••••&password=••••••••");
    }
    let store = store_text(&h);
    assert!(!store.contains("842913") && !store.contains("hunter two"), "the store holds a prompt answer");
}

#[test]
fn a_request_marked_no_log_is_sent_but_not_recorded() {
    let h = Harness::new();
    let server = super::keep_alive_server(2);
    let (_ws, root) = workspace(&h, &format!("# @no-log\nGET {server}/secret\n\n###\nGET {server}/plain\n"));

    let sent = h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    assert_eq!(sent["status"], 200, "it is sent");
    h.ok("send_request", send_args(&root, &request(&h, &root, 1)));

    let urls: Vec<Value> = all_history(&h).iter().map(|e| e["url"].clone()).collect();
    assert_eq!(urls, [json!(format!("{server}/plain"))]);
}

/// Turns the History switch on or off, as Settings does (the whole settings object).
fn switch_history(h: &Harness, on: bool) {
    let mut settings = h.ok("get_settings", json!({}));
    settings["history"]["enabled"] = json!(on);
    h.ok("save_settings", json!({ "settings": settings }));
}

#[test]
fn history_is_on_by_default_and_while_it_is_off_nothing_is_recorded_and_what_was_stays() {
    let h = Harness::new();
    assert_eq!(h.ok("get_settings", json!({}))["history"]["enabled"], true);
    let server = answer_each();
    let (_ws, root) = workspace(&h, &format!("GET {server}/one\n"));
    let one = request(&h, &root, 0);
    h.ok("send_request", send_args(&root, &one));

    // Turned off, and asked to Keep what's there.
    switch_history(&h, false);
    h.ok("send_request", send_args(&root, &one));
    assert_eq!(all_history(&h).len(), 1, "nothing is recorded while it's off; what was, stays");

    let h = h.restart();
    crate::load_settings(h.app.handle());
    assert_eq!(h.ok("get_settings", json!({}))["history"]["enabled"], false, "the switch is remembered");
    h.ok("open_workspace", json!({ "path": root }));
    h.ok("send_request", send_args(&root, &one));
    assert_eq!(all_history(&h).len(), 1);

    switch_history(&h, true);
    h.ok("send_request", send_args(&root, &one));
    assert_eq!(all_history(&h).len(), 2);
}

#[test]
fn settings_can_show_where_history_is_kept_in_the_config_folder() {
    let h = Harness::new();
    let location = h.ok("history_location", json!({}));
    assert_eq!(location, json!(h.config_dir().join("history.sqlite3")));
}

/// The bytes of every History store file in `dir` (the database and its journal).
pub(super) fn store_bytes(dir: &Path) -> Vec<u8> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| is_store(p))
        .flat_map(|p| std::fs::read(p).unwrap())
        .collect()
}

#[test]
fn turning_history_off_with_delete_clears_every_workspaces_history_from_disk() {
    let h = Harness::new();
    let server = answer_each();
    let (_ws_a, root_a) = workspace(&h, &format!("GET {server}/a?q=needle-a\n"));
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 0)));
    let (_ws_b, root_b) = workspace(&h, &format!("GET {server}/b?q=needle-b\n"));
    let b = request(&h, &root_b, 0);
    h.ok("send_request", send_args(&root_b, &b));
    let opened = h.ok("open_history_entry", json!({ "id": all_history(&h)[0]["id"] }));

    // Turned off, and asked to Delete what's there.
    switch_history(&h, false);
    h.ok("clear_all_history", json!({}));

    assert_eq!(all_history(&h), Vec::<Value>::new());
    h.ok("open_workspace", json!({ "path": root_a }));
    assert_eq!(all_history(&h), Vec::<Value>::new(), "every workspace's");
    let store = store_bytes(&h.config_dir());
    for needle in ["needle-a", "needle-b"] {
        assert!(!store.windows(needle.len()).any(|w| w == needle.as_bytes()), "{needle} is gone from disk");
    }
    // An entry open in the viewer stays readable until it's closed (ADR-0006).
    assert_eq!(fetch(&h, &opened["response"]["id"], "raw").unwrap(), b"ok");

    // With the switch back on, recording starts again.
    switch_history(&h, true);
    h.ok("open_workspace", json!({ "path": root_b }));
    h.ok("send_request", send_args(&root_b, &b));
    assert_eq!(all_history(&h).len(), 1);
}
