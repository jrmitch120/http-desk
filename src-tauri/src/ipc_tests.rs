//! End-to-end IPC tests: invoke the real command handlers with the same JSON
//! payloads the frontend sends (camelCase args, frontend-only `_key` fields),
//! covering the vertical slice open → edit → toggle → send → save → reopen.

mod confinement;
mod deleting;
mod folder_envs;
mod paths;
mod preview;
mod renaming;
mod usages;
mod watcher;

// The origin Tauri serves the app from; capabilities only apply to it.
#[cfg(windows)]
const APP_URL: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const APP_URL: &str = "tauri://localhost";

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Manager;

struct Harness {
    app: tauri::App<tauri::test::MockRuntime>,
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    /// This app's settings folder; deleted when the harness is dropped.
    cfg: tempfile::TempDir,
    /// Stands in for the OS trash: `delete_path` moves entries here.
    trash_bin: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let cfg = tempfile::tempdir().unwrap();
        let builder = mock_builder().manage(super::ConfigDir(cfg.path().to_path_buf()));
        let app = super::with_commands(builder, |_| Ok(())).build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let trash_bin = tempfile::tempdir().unwrap();
        let bin = trash_bin.path().to_path_buf();
        app.state::<super::AppState>()
            .trash
            .replace(move |path| std::fs::rename(path, bin.join(path.file_name().unwrap())).map_err(|e| e.to_string()));
        Harness { app, webview, cfg, trash_bin }
    }

    /// Makes every move to the trash fail, like a volume without a trash.
    fn trash_unavailable(&self) {
        self.app.state::<super::AppState>().trash.replace(|_| Err("no trash on this volume".into()));
    }

    /// Names of the entries moved to the (fake) trash, sorted.
    fn trashed(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.trash_bin.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn config_dir(&self) -> std::path::PathBuf {
        self.cfg.path().to_path_buf()
    }

    fn call(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: APP_URL.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args).unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
    }
}

/// One-shot HTTP server on a background thread; returns (url, received raw request).
fn capture_server() -> (String, mpsc::Receiver<String>) {
    json_server(r#"{"ok":true}"#)
}

/// Like [`capture_server`], answering with `body` as JSON.
fn json_server(body: &'static str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_millis(500))).unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stream.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let body = body.as_bytes();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(body);
        tx.send(String::from_utf8_lossy(&buf).into_owned()).unwrap();
    });
    (url, rx)
}

#[test]
fn vertical_slice_over_ipc() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, received) = capture_server();
    let file_path = root.join("api.http");
    std::fs::write(
        &file_path,
        "### List\nGET {{baseUrl}}/items?page=1\nAccept: application/json\nX-Debug: on\n\n### Untouched\n// hand formatted\nGET   https://example.com\n",
    )
    .unwrap();
    std::fs::write(root.join("http-client.env.json"), json!({ "local": { "baseUrl": server } }).to_string()).unwrap();

    // Open workspace
    let info = h.ok("open_workspace", json!({ "path": root }));
    assert_eq!(info["tree"]["children"][0]["name"], "api.http");

    // Load, then edit like the GUI: disable a header, add a disabled param, add frontend keys.
    let path = file_path.to_string_lossy().to_string();
    let mut file = h.ok("read_http_file", json!({ "path": path }));
    let req = &mut file["requests"][0];
    req["_key"] = json!("k1");
    req["headers"]["items"][1]["enabled"] = json!(false);
    req["query"]["items"].as_array_mut().unwrap().push(json!({ "enabled": false, "name": "size", "value": "50" }));
    req["auth"] = json!({ "enabled": true, "kind": "bearer", "token": "{{token}}" });
    file["requests"][1]["_key"] = json!("k2");

    // Execute the unsaved edit against a real socket.
    let resp = h.ok(
        "send_request",
        json!({ "runId": "r1", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": "local" }),
    );
    assert_eq!(resp["status"], 200);
    assert_eq!(resp["bodyText"], r#"{"ok":true}"#);
    assert_eq!(resp["warnings"][0], "Undefined variables: token");
    let raw = received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(raw.starts_with("GET /items?page=1 HTTP/1.1"), "{raw}");
    assert!(raw.to_lowercase().contains("accept: application/json"));
    assert!(!raw.to_lowercase().contains("x-debug"), "disabled header must not be sent");
    assert!(!raw.contains("size=50"));

    // Save, check disk content, reopen.
    let saved = h.ok("save_http_file", json!({ "path": path, "file": file }));
    assert_eq!(saved["requests"].as_array().unwrap().len(), 2);
    let text = std::fs::read_to_string(&file_path).unwrap();
    assert!(text.starts_with("### List\nGET {{baseUrl}}/items?page=1\n#~ &size=50\nAuthorization: Bearer {{token}}\nAccept: application/json\n#~ X-Debug: on\n"), "{text}");
    assert!(
        text.ends_with("### Untouched\n// hand formatted\nGET   https://example.com\n"),
        "untouched request kept byte-for-byte: {text}"
    );

    let reopened = h.ok("read_http_file", json!({ "path": path }));
    let r = &reopened["requests"][0];
    assert_eq!(r["headers"]["items"][1], json!({ "enabled": false, "name": "X-Debug", "value": "on" }));
    assert_eq!(r["query"]["items"][1], json!({ "enabled": false, "name": "size", "value": "50" }));
    assert_eq!(r["auth"]["kind"], "bearer");

    // Source preview command.
    let src = h.ok("render_request", json!({ "request": r }));
    assert!(src.as_str().unwrap().contains("#~ X-Debug: on"));
}

#[test]
fn opening_a_repo_subfolder_gitignores_its_private_env_file() {
    let h = Harness::new();
    let repo = tempfile::tempdir().unwrap();
    let repo = repo.path().canonicalize().unwrap();
    std::fs::create_dir(repo.join(".git")).unwrap();
    let ws = repo.join("api");
    std::fs::create_dir(&ws).unwrap();
    std::fs::write(ws.join("http-client.private.env.json"), r#"{ "dev": { "token": "s3cret" } }"#).unwrap();

    let info = h.ok("open_workspace", json!({ "path": ws }));
    assert_eq!(info["gitignoreUpdated"], true);
    assert!(std::fs::read_to_string(ws.join(".gitignore")).unwrap().contains("http-client.private.env.json"));
    assert_eq!(h.ok("load_environments", json!({}))["privateFileIgnored"], true);

    let again = h.ok("open_workspace", json!({ "path": ws }));
    assert_eq!(again["gitignoreUpdated"], false);
}

#[test]
fn environments_and_openapi_over_ipc() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::create_dir(root.join(".git")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let report = h.ok(
        "save_environments",
        json!({ "set": { "shared": [], "environments": [{ "name": "dev", "variables": [
            { "name": "baseUrl", "value": "http://localhost", "secret": false },
            { "name": "token", "value": "s3cret", "secret": true }
        ] }], "privateFileIgnored": null } }),
    );
    assert_eq!(report["gitignoreUpdated"], true);
    assert!(!std::fs::read_to_string(root.join("http-client.env.json")).unwrap().contains("s3cret"));
    let set = h.ok("load_environments", json!({}));
    assert_eq!(set["privateFileIgnored"], true);
    assert_eq!(set["environments"][0]["variables"][1]["secret"], true);

    let spec = root.join("spec.yaml");
    std::fs::write(
        &spec,
        "openapi: 3.0.3\ninfo: {title: Mini, version: '1'}\nservers: [{url: 'https://api.mini.dev'}]\npaths:\n  /things/{id}:\n    get:\n      operationId: getThing\n      tags: [things]\n      parameters:\n        - {name: id, in: path, required: true, schema: {type: integer, example: 7}}\n        - {name: verbose, in: query, schema: {type: boolean}}\n      responses: {'200': {description: ok}}\n",
    )
    .unwrap();
    let source = spec.to_string_lossy().to_string();
    let summary = h.ok("openapi_load", json!({ "source": source }));
    assert_eq!(summary["operations"][0]["id"], "getThing");

    let out_dir = root.join("mini");
    let args = |dry: bool, overwrite: bool| {
        json!({ "source": source, "options": { "operationIds": [], "grouping": "tag", "baseUrlVariable": "baseUrl", "singleFileName": null },
                "outputDir": out_dir, "overwrite": overwrite, "dryRun": dry })
    };
    let dry = h.ok("openapi_generate", args(true, false));
    assert_eq!(dry["written"], false);
    let done = h.ok("openapi_generate", args(false, false));
    assert_eq!(done["written"], true);
    let generated = std::fs::read_to_string(out_dir.join("things.http")).unwrap();
    assert!(generated.contains("GET {{baseUrl}}/things/{{id}}"), "{generated}");
    assert!(generated.contains("#~ &verbose="), "optional params are generated disabled: {generated}");
    // A second run reports conflicts instead of overwriting.
    let again = h.ok("openapi_generate", args(false, false));
    assert_eq!((again["written"].clone(), again["conflicts"].as_array().unwrap().len()), (json!(false), 1));
    let env = std::fs::read_to_string(root.join("http-client.env.json")).unwrap();
    assert!(env.contains("https://api.mini.dev"), "{env}");
}

/// ⌘Q and Dock Quit always go through the window's close flow, which asks the
/// frontend (the source of truth for unsaved edits) and closes at once when
/// nothing is unsaved. So a lost or late `set_unsaved` can't skip the prompt.
/// Only a logout or shutdown trusts the flag, so a clean app doesn't block it.
#[test]
fn quitting_always_asks_the_window_and_only_logout_trusts_the_unsaved_flag() {
    use super::quit::{on_quit_request, QuitReason::*};
    use tauri::Manager;
    let h = Harness::new();
    let app = h.webview.app_handle();

    // `set_unsaved` never arrived (failed, or ⌘Q came first).
    assert!(!on_quit_request(app, User), "a quit by the user defers to the window");
    assert!(app.get_webview_window("main").is_some());
    assert!(on_quit_request(app, Logout), "nothing reported unsaved: logout isn't blocked");

    h.ok("set_unsaved", json!({ "unsaved": true }));
    assert!(!on_quit_request(app, User));
    assert!(!on_quit_request(app, Logout), "unsaved: even a logout asks first");

    h.ok("set_unsaved", json!({ "unsaved": false }));
    assert!(!on_quit_request(app, User));
    assert!(on_quit_request(app, Logout));
}

#[test]
fn format_body_keeps_numbers_exact_and_reports_invalid_json_as_a_string() {
    let h = Harness::new();
    let input = r#"{"id": 9007199254740993, "price": 10.50, "e": 1e3}"#;
    let pretty = h.ok("format_body", json!({ "text": input, "kind": "json", "mode": "pretty" }));
    assert_eq!(pretty, json!("{\n  \"id\": 9007199254740993,\n  \"price\": 10.50,\n  \"e\": 1e3\n}"));
    let minified = h.ok("format_body", json!({ "text": pretty, "kind": "json", "mode": "minify" }));
    assert_eq!(minified, json!(r#"{"id":9007199254740993,"price":10.50,"e":1e3}"#));

    let err =
        h.call("format_body", json!({ "text": "{\"id\": {{id}}}", "kind": "json", "mode": "pretty" })).unwrap_err();
    assert!(err.as_str().unwrap().starts_with("Invalid JSON at line 1, column 9: expected a quoted key"), "{err}");
}

#[test]
fn a_beautified_body_is_saved_to_the_http_file_with_its_numbers_as_written() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let file_path = root.join("api.http");
    std::fs::write(
        &file_path,
        "### Create\nPOST https://example.com/items\nContent-Type: application/json\n\n{\"id\": 9007199254740993, \"price\": 10.50, \"e\": 1e3}\n",
    )
    .unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();

    // What Beautify does: format the body text and write the result back into the model.
    let mut file = h.ok("read_http_file", json!({ "path": path }));
    let text = file["requests"][0]["body"]["text"].clone();
    file["requests"][0]["body"]["text"] =
        h.ok("format_body", json!({ "text": text, "kind": "json", "mode": "pretty" }));
    h.ok("save_http_file", json!({ "path": path, "file": file }));

    let saved = std::fs::read_to_string(&file_path).unwrap();
    assert!(
        saved.ends_with("\n{\n  \"id\": 9007199254740993,\n  \"price\": 10.50,\n  \"e\": 1e3\n}\n"),
        "numbers saved as written: {saved}"
    );
}

#[test]
fn format_body_beautifies_xml_and_rejects_xml_that_doesnt_nest() {
    let h = Harness::new();
    let pretty = h.ok("format_body", json!({ "text": "<a><b>1</b></a>", "kind": "xml", "mode": "pretty" }));
    assert_eq!(pretty, json!("<a>\n  <b>1</b>\n</a>"));
    let err = h.call("format_body", json!({ "text": "<a><b></a>", "kind": "xml", "mode": "pretty" })).unwrap_err();
    assert!(err.as_str().unwrap().starts_with("Invalid XML at line 1, column 7"), "{err}");
}

#[test]
fn hexdump_renders_a_stored_body_by_response_id_and_reports_an_expired_one() {
    let h = Harness::new();
    // What send_request does with a response's body.
    h.app.state::<super::AppState>().bodies.lock().unwrap().push(
        "resp-1".into(),
        b"\x89PNG\r\n\x1a\n".to_vec(),
        Some("image/png".into()),
    );

    let dump = h.ok("hexdump", json!({ "responseId": "resp-1" }));
    assert_eq!(dump, json!(format!("00000000  89 50 4e 47 0d 0a 1a 0a{}  .PNG....", " ".repeat(24))));

    let err = h.call("hexdump", json!({ "responseId": "gone" })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
}

/// Serves one response with `content_type` and `body`; returns the URL.
fn serve_once(content_type: &'static str, body: Vec<u8>) -> String {
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
        let head = format!("HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n", body.len());
        let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body));
    });
    url
}

/// Sends `GET {url}/` from a fresh workspace and returns the response.
fn send_get(h: &Harness, url: &str) -> Value {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let path = root.join("get.http");
    std::fs::write(&path, format!("GET {url}/\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let file = h.ok("read_http_file", json!({ "path": path }));
    h.ok(
        "send_request",
        json!({ "runId": "p1", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null }),
    )
}

#[test]
fn a_small_json_response_arrives_with_its_pretty_text_numbers_as_sent() {
    let h = Harness::new();
    let url = serve_once("application/json", br#"{"id":9007199254740993,"price":10.50}"#.to_vec());
    let resp = send_get(&h, &url);
    assert_eq!(resp["prettyText"], json!("{\n  \"id\": 9007199254740993,\n  \"price\": 10.50\n}"));
}

#[test]
fn a_small_response_that_doesnt_parse_has_its_raw_body_as_pretty_text() {
    let h = Harness::new();
    let url = serve_once("application/json", br#"{"id": 1, oops}"#.to_vec());
    assert_eq!(send_get(&h, &url)["prettyText"], json!(r#"{"id": 1, oops}"#));
}

#[test]
fn a_plain_text_response_has_no_pretty_text() {
    let h = Harness::new();
    let url = serve_once("text/plain", b"hello".to_vec());
    assert_eq!(send_get(&h, &url)["prettyText"], Value::Null);
}

#[test]
fn a_large_json_response_is_formatted_only_when_asked_for_by_response_id() {
    let h = Harness::new();
    let items: Vec<String> = (0..60_000).map(|i| format!(r#"{{"id":1{i:05}0000000001,"n":"item"}}"#)).collect();
    let body = format!("[{}]", items.join(","));
    assert!(body.len() > super::PRETTY_INLINE_BYTES);
    let url = serve_once("application/json; charset=utf-8", body.into_bytes());

    let resp = send_get(&h, &url);
    assert_eq!(resp["prettyText"], Value::Null);

    let pretty = h.ok("pretty_response", json!({ "responseId": resp["id"] }));
    let pretty = pretty.as_str().unwrap();
    assert!(
        pretty.starts_with("[\n  {\n    \"id\": 1000000000000001,\n    \"n\": \"item\"\n  },\n"),
        "{}",
        &pretty[..80]
    );
    assert!(pretty.ends_with("    \"id\": 1599990000000001,\n    \"n\": \"item\"\n  }\n]"));
}

#[test]
fn pretty_response_rejects_an_evicted_id_and_a_body_that_doesnt_parse() {
    let h = Harness::new();
    h.app.state::<super::AppState>().bodies.lock().unwrap().push(
        "bad".into(),
        br#"{"id": 1, oops}"#.to_vec(),
        Some("application/json".into()),
    );
    let err = h.call("pretty_response", json!({ "responseId": "bad" })).unwrap_err();
    assert!(err.as_str().unwrap().starts_with("Invalid JSON at line 1"), "{err}");

    let err = h.call("pretty_response", json!({ "responseId": "gone" })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
}

#[test]
fn a_sent_response_is_filtered_by_id_with_numbers_as_the_server_sent_them() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, _received) = json_server(
        r#"{"items":[{"id":1234567890123456789,"status":"sold","price":1e3},{"id":2,"status":"available"}]}"#,
    );
    let file_path = root.join("api.http");
    std::fs::write(&file_path, format!("GET {server}/items\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let resp = h.ok(
        "send_request",
        json!({ "runId": "r1", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null }),
    );
    let id = resp["id"].clone();

    let result = h.ok("filter_response", json!({ "responseId": id, "expression": r#"$.items[?(@.status=="sold")]"# }));
    assert_eq!(
        result,
        json!({ "matches": 1, "text": "[\n  {\n    \"id\": 1234567890123456789,\n    \"status\": \"sold\",\n    \"price\": 1e3\n  }\n]" })
    );
    // Typing on re-uses the parsed body.
    assert_eq!(h.ok("filter_response", json!({ "responseId": id, "expression": "$.items[*].id" }))["matches"], 2);

    let err = h.call("filter_response", json!({ "responseId": id, "expression": "$.items[" })).unwrap_err();
    assert!(err.as_str().unwrap().starts_with("Invalid JSONPath at position "), "{err}");
    let err = h.call("filter_response", json!({ "responseId": "gone", "expression": "$" })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
}

#[test]
fn a_sent_response_has_a_shape_summary_for_key_completion() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, _received) = json_server(r#"{"items":[{"id":1,"name":"Rex"},{"id":2,"tags":["a"]}],"total":2}"#);
    let file_path = root.join("api.http");
    std::fs::write(&file_path, format!("GET {server}/items\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let resp = h.ok(
        "send_request",
        json!({ "runId": "r1", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null }),
    );

    let shape = h.ok("response_shape", json!({ "responseId": resp["id"] }));
    assert_eq!(
        shape,
        json!({ "keys": [
            ["items", { "items": { "keys": [["id", {}], ["name", {}], ["tags", { "items": {} }]] } }],
            ["total", {}],
        ] })
    );
    let err = h.call("response_shape", json!({ "responseId": "gone" })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
}

#[test]
fn errors_are_strings() {
    let h = Harness::new();
    let err = h.call("get_tree", json!({})).unwrap_err();
    assert_eq!(err, json!("No workspace is open"));
}

#[test]
fn send_errors_arrive_classified() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    std::fs::write(root.join("a.http"), format!("GET http://127.0.0.1:{port}/x\n\n###\nGET {{{{baseUrl}}}}/x\n"))
        .unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let file = h.ok("read_http_file", json!({ "path": root.join("a.http") }));
    let send = |i: usize| {
        h.call(
            "send_request",
            json!({ "runId": "r1", "request": file["requests"][i], "filePath": root.join("a.http"), "fileVariables": [], "environment": null }),
        )
        .unwrap_err()
    };

    let err = send(0);
    assert_eq!((&err["kind"], &err["details"]), (&json!("refused"), &json!({ "host": "127.0.0.1", "port": port })));
    // The message is the error chain, in the OS's own words ("Connection refused" on
    // Linux and macOS, "actively refused it" on Windows); the UI's heading and hint
    // come from `kind`, so only check that it's about this request.
    assert!(err["message"].as_str().unwrap().contains(&format!("http://127.0.0.1:{port}/x")), "{err}");

    // Errors found before sending are classified too.
    let err = send(1);
    assert_eq!((&err["kind"], &err["details"]), (&json!("unresolvedVariable"), &json!({ "names": ["baseUrl"] })));
}

#[test]
fn watcher_reports_external_changes_but_not_our_own_writes() {
    use tauri::Listener;
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let path = root.join("a.http");
    std::fs::write(&path, "GET https://a\n").unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let (tx, rx) = mpsc::channel::<String>();
    h.webview.listen_any("workspace-changed", move |e| {
        let _ = tx.send(e.payload().to_string());
    });
    // Let the watcher settle: FSEvents can deliver the setup write above late, so
    // drain until no event has arrived for a while before acting.
    while rx.recv_timeout(std::time::Duration::from_millis(600)).is_ok() {}

    let file = h.ok("read_http_file", json!({ "path": path }));
    h.ok("save_http_file", json!({ "path": path, "file": file }));
    let own = rx.recv_timeout(std::time::Duration::from_secs(2));
    assert!(own.as_ref().map_or(true, |p| !p.contains("a.http\"")), "own write was reported: {own:?}");

    std::fs::write(&path, "GET https://changed\n").unwrap();
    let ext = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("external change reported");
    assert!(ext.contains("a.http"), "{ext}");
}

#[cfg(unix)]
#[test]
fn saving_through_a_symlink_updates_the_target_and_keeps_the_link() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::create_dir(root.join("shared")).unwrap();
    let target = root.join("shared/real.http");
    std::fs::write(&target, "### R\nGET https://old\n").unwrap();
    let link = root.join("link.http");
    std::os::unix::fs::symlink("shared/real.http", &link).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let mut file = h.ok("read_http_file", json!({ "path": link }));
    file["requests"][0]["url"] = json!("https://new");
    h.ok("save_http_file", json!({ "path": link, "file": file }));

    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "link was replaced by a file");
    assert_eq!(std::fs::read_link(&link).unwrap(), std::path::Path::new("shared/real.http"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "### R\nGET https://new\n");
}

#[test]
fn saving_refuses_a_line_break_in_a_header_value_and_leaves_the_file_alone() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = ws.path().canonicalize().unwrap();
    let path = root.join("a.http");
    std::fs::write(&path, "### R\nGET https://x\nAccept: */*\n").unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let mut file = h.ok("read_http_file", json!({ "path": path }));
    file["requests"][0]["headers"]["items"][0]["value"] = json!("*/*\nX-Injected: 1");
    let err = h.call("save_http_file", json!({ "path": path, "file": file })).unwrap_err();
    assert_eq!(err, json!("Request \"R\": the value of header \"Accept\" contains a line break"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "### R\nGET https://x\nAccept: */*\n");
}

#[cfg(unix)]
#[test]
fn saving_keeps_the_file_mode() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let path = root.join("private.http");
    std::fs::write(&path, "### R\nGET https://old\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let mut file = h.ok("read_http_file", json!({ "path": path }));
    file["requests"][0]["url"] = json!("https://new");
    h.ok("save_http_file", json!({ "path": path, "file": file }));

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "### R\nGET https://new\n");
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}

/// Called directly, so the settings file can be a symlink set up beforehand.
#[cfg(unix)]
#[test]
fn settings_are_replaced_atomically_through_symlinks() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("dotfiles-settings.json");
    std::fs::write(&real, "{}").unwrap();
    let path = dir.path().join("settings.json");
    std::os::unix::fs::symlink(&real, &path).unwrap();
    let inode = std::fs::metadata(&real).unwrap().ino();

    let settings = super::AppSettings { theme: "light".into(), ..Default::default() };
    super::write_settings(&path, &settings).unwrap();

    // A new inode means the file was replaced by a rename, not rewritten in place.
    assert_ne!(std::fs::metadata(&real).unwrap().ino(), inode);
    assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["theme"], "light");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2, "no temp file left behind");
}

/// Settings files written before the pane sizes were stored still load, with the default sizes.
#[test]
fn settings_without_pane_sizes_load_with_defaults() {
    let old = r#"{"theme":"light","layout":"vertical","checkUpdates":false}"#;
    let settings: super::AppSettings = serde_json::from_str(old).unwrap();
    let json = serde_json::to_value(&settings).unwrap();
    assert_eq!(json["theme"], "light");
    assert_eq!(json["checkUpdates"], false);
    assert_eq!(json["sidebarWidth"], 280.0);
    assert_eq!(json["splitRatio"], json!({ "horizontal": 0.5, "vertical": 0.5 }));

    // One layout's ratio saved on its own keeps the default for the other.
    let partial: super::AppSettings = serde_json::from_str(r#"{"splitRatio":{"vertical":0.3}}"#).unwrap();
    let json = serde_json::to_value(&partial).unwrap();
    assert_eq!(json["splitRatio"], json!({ "horizontal": 0.5, "vertical": 0.3 }));
}

/// A theme chosen by an older version loads unchanged; a settings file without one follows the OS.
#[test]
fn saved_themes_load_unchanged_and_a_missing_theme_follows_the_system() {
    for theme in ["dark", "light"] {
        let old: super::AppSettings = serde_json::from_str(&format!(r#"{{"theme":"{theme}"}}"#)).unwrap();
        assert_eq!(serde_json::to_value(&old).unwrap()["theme"], theme);
    }
    let fresh: super::AppSettings = serde_json::from_str(r#"{"layout":"vertical"}"#).unwrap();
    assert_eq!(serde_json::to_value(&fresh).unwrap()["theme"], "system");
    assert_eq!(serde_json::to_value(super::AppSettings::default()).unwrap()["theme"], "system");
}

/// #79: whether an environment is production, and its colour, live in the app
/// settings keyed by workspace + environment name. They survive a restart and
/// never touch the env files, so other tools don't see them as variables.
#[test]
fn environment_settings_survive_a_restart_and_leave_the_env_files_alone() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let env_file = r#"{ "prod": { "baseUrl": "https://api.example.com" } }"#;
    std::fs::write(root.join("http-client.env.json"), env_file).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let mut settings = h.ok("get_settings", json!({}));
    assert_eq!(settings["environmentSettings"], json!({}));
    let ws_key = root.to_string_lossy().to_string();
    settings["environmentSettings"] = json!({ ws_key.clone(): { "prod": { "production": true, "color": "red" } } });
    h.ok("save_settings", json!({ "settings": settings }));

    // A restart: the defaults, then whatever settings.json holds.
    *h.app.state::<super::AppState>().settings.lock().unwrap() = super::AppSettings::default();
    super::load_settings(h.app.handle());
    let reloaded = h.ok("get_settings", json!({}));
    assert_eq!(reloaded["environmentSettings"][&ws_key]["prod"], json!({ "production": true, "color": "red" }));
    assert_eq!(std::fs::read_to_string(root.join("http-client.env.json")).unwrap(), env_file);
    assert!(!root.join("http-client.private.env.json").exists());
}

/// #83: the Environments matrix edits the same set `save_environments` takes:
/// a variable added to all environments, a cell's Secret toggled on or off.
/// Secret values only ever reach the private file, and a cell made shareable
/// moves its value back to the shared file.
#[test]
fn saving_matrix_changes_keeps_secrets_only_in_the_private_file() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let var = |name: &str, value: &str, secret: bool| json!({ "name": name, "value": value, "secret": secret });
    let save = |dev: Vec<Value>, prod: Vec<Value>| {
        h.ok(
            "save_environments",
            json!({ "set": { "shared": [var("version", "v1", false)], "environments": [
                { "name": "dev", "variables": dev }, { "name": "prod", "variables": prod }
            ], "privateFileIgnored": null } }),
        );
    };
    let files = || {
        let read = |name: &str| -> Value {
            serde_json::from_str(&std::fs::read_to_string(root.join(name)).unwrap_or_else(|_| "{}".into())).unwrap()
        };
        (read("http-client.env.json"), read("http-client.private.env.json"))
    };

    // "Add variable to all environments" (apiKey, empty everywhere), and token a Secret in each cell.
    save(
        vec![var("baseUrl", "http://dev", false), var("token", "dev-tok", true), var("apiKey", "", false)],
        vec![var("baseUrl", "https://prod", false), var("token", "prod-tok", true), var("apiKey", "", false)],
    );
    let (shared, private) = files();
    assert_eq!(shared["dev"], json!({ "baseUrl": "http://dev", "apiKey": "" }), "{shared}");
    assert_eq!(shared["prod"], json!({ "baseUrl": "https://prod", "apiKey": "" }), "{shared}");
    assert_eq!(private, json!({ "dev": { "token": "dev-tok" }, "prod": { "token": "prod-tok" } }));

    // Then prod's token cell made shareable, dev's baseUrl and apiKey cells made Secrets.
    save(
        vec![var("baseUrl", "http://dev", true), var("token", "dev-tok", true), var("apiKey", "k-dev", true)],
        vec![var("baseUrl", "https://prod", false), var("token", "prod-tok", false), var("apiKey", "", false)],
    );
    let (shared, private) = files();
    let text = std::fs::read_to_string(root.join("http-client.env.json")).unwrap();
    for secret in ["http://dev", "dev-tok", "k-dev"] {
        assert!(!text.contains(secret), "{secret} leaked into the shared file: {text}");
    }
    assert_eq!(shared["prod"], json!({ "baseUrl": "https://prod", "token": "prod-tok", "apiKey": "" }));
    assert_eq!(private["dev"], json!({ "baseUrl": "http://dev", "token": "dev-tok", "apiKey": "k-dev" }));
    assert_eq!(private.get("prod"), None, "prod has no Secrets left: {private}");

    let set = h.ok("load_environments", json!({}));
    let secrets = |env: usize| -> Vec<(String, bool)> {
        set["environments"][env]["variables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["name"].as_str().unwrap().to_string(), v["secret"].as_bool().unwrap()))
            .collect()
    };
    assert!(secrets(0).iter().all(|(_, secret)| *secret), "{:?}", secrets(0));
    assert!(secrets(1).iter().all(|(_, secret)| !*secret), "{:?}", secrets(1));
}

/// #83: the Environments modal opens on the matrix unless the user picked the
/// list, and that choice survives a restart.
#[test]
fn the_environments_view_defaults_to_the_matrix_and_is_remembered() {
    let h = Harness::new();
    let mut settings = h.ok("get_settings", json!({}));
    assert_eq!(settings["envView"], "matrix");
    settings["envView"] = json!("list");
    h.ok("save_settings", json!({ "settings": settings }));

    *h.app.state::<super::AppState>().settings.lock().unwrap() = super::AppSettings::default();
    super::load_settings(h.app.handle());
    assert_eq!(h.ok("get_settings", json!({}))["envView"], "list");
}

/// Paths reported by `workspace-changed` until no event has arrived for `quiet`.
fn changed_paths(rx: &mpsc::Receiver<String>, quiet: std::time::Duration) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(payload) = rx.recv_timeout(quiet) {
        let v: Value = serde_json::from_str(&payload).unwrap();
        out.extend(v["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()));
    }
    out
}

/// Deletes are covered in `deleting::watcher_ignores_our_own_deletes`.
#[test]
fn watcher_ignores_our_own_renames_moves_and_new_folders() {
    use tauri::Listener;
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("a.http"), "GET https://a\n").unwrap();
    std::fs::create_dir(root.join("old")).unwrap();
    std::fs::write(root.join("old/inner.http"), "GET https://inner\n").unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let (tx, rx) = mpsc::channel::<String>();
    h.webview.listen_any("workspace-changed", move |e| {
        let _ = tx.send(e.payload().to_string());
    });
    changed_paths(&rx, std::time::Duration::from_millis(600));

    // Join one component at a time: on Windows `join("dir/b.http")` keeps the `/`,
    // which never equals the `\` paths the watcher reports.
    let p = |rel: &str| rel.split('/').fold(root.clone(), |acc, c| acc.join(c)).to_string_lossy().to_string();
    h.ok("rename_path", json!({ "from": p("a.http"), "to": p("b.http") }));
    h.ok("create_dir", json!({ "path": p("dir") }));
    h.ok("rename_path", json!({ "from": p("b.http"), "to": p("dir/b.http") }));
    h.ok("rename_path", json!({ "from": p("old"), "to": p("new") }));

    let own = changed_paths(&rx, std::time::Duration::from_secs(2));
    assert!(own.is_empty(), "own operations were reported: {own:?}");

    std::fs::write(root.join("dir/b.http"), "GET https://changed\n").unwrap();
    std::fs::write(root.join("new/inner.http"), "GET https://changed\n").unwrap();
    let ext = changed_paths(&rx, std::time::Duration::from_secs(2));
    assert!(ext.contains(&p("dir/b.http")), "external change after a move is still reported: {ext:?}");
    assert!(ext.contains(&p("new/inner.http")), "external change inside a moved folder is still reported: {ext:?}");
}

/// Story 53: a settings save that can't be written is reported, so the UI can
/// show "Could not save settings: …" instead of pretending it worked.
#[test]
fn saving_settings_reports_a_failed_write() {
    let h = Harness::new();
    let settings = h.ok("get_settings", json!({}));
    h.ok("save_settings", json!({ "settings": settings }));
    assert!(h.config_dir().join("settings.json").is_file());

    // A folder where the settings file should go: the write can't replace it.
    std::fs::remove_file(h.config_dir().join("settings.json")).unwrap();
    std::fs::create_dir(h.config_dir().join("settings.json")).unwrap();
    let err =
        h.call("save_settings", json!({ "settings": settings })).expect_err("a failed write was reported as saved");
    assert!(err.as_str().unwrap().starts_with("Could not save settings to "), "{err}");
}

#[test]
fn harness_keeps_settings_in_its_own_temp_dir_and_removes_it() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    h.ok("open_workspace", json!({ "path": ws.path() }));
    let cfg = h.config_dir();
    assert!(cfg.join("settings.json").is_file(), "settings were not written to {}", cfg.display());
    drop(h);
    assert!(!cfg.exists(), "{} was left behind", cfg.display());
}

/// One-shot HTTP server that sends a `len`-byte text body in `chunks` pieces, `gap` apart.
fn trickle_server(len: usize, chunks: usize, gap: std::time::Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (mut head, mut buf) = (Vec::new(), [0u8; 4096]);
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => head.extend_from_slice(&buf[..n]),
            }
        }
        let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {len}\r\n\r\n");
        for _ in 0..chunks {
            std::thread::sleep(gap);
            if stream.write_all(&vec![b'x'; len / chunks]).and_then(|_| stream.flush()).is_err() {
                return;
            }
        }
    });
    url
}

#[test]
fn a_downloading_body_emits_growing_progress_for_its_run_until_the_send_returns() {
    use tauri::Listener;
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let file_path = root.join("dl.http");
    let server = trickle_server(4000, 4, std::time::Duration::from_millis(150));
    std::fs::write(&file_path, format!("GET {server}/download\n")).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));

    let (tx, rx) = mpsc::channel::<Value>();
    h.webview.listen_any("send-progress", move |e| {
        let _ = tx.send(serde_json::from_str(e.payload()).unwrap());
    });
    let resp = h.ok(
        "send_request",
        json!({ "runId": "dl-1", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null }),
    );
    assert_eq!(resp["bodySize"], 4000);

    let events: Vec<Value> = rx.try_iter().collect();
    assert!(events.len() >= 2, "too few progress events: {events:?}");
    assert!(events.iter().all(|e| e["runId"] == "dl-1"), "{events:?}");
    let received: Vec<u64> = events.iter().map(|e| e["received"].as_u64().unwrap()).collect();
    assert!(received.windows(2).all(|w| w[0] < w[1]), "counts must grow: {received:?}");
    assert!(*received.last().unwrap() <= 4000, "{received:?}");

    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(rx.try_iter().count(), 0, "progress was emitted after the send returned");
}

/// Serves `count` responses over one kept-alive connection; returns the URL.
/// A second connection is never accepted.
fn keep_alive_server(count: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for _ in 0..count {
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            while !buf.ends_with(b"\r\n\r\n") {
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => buf.push(byte[0]),
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\n\r\nok");
        }
    });
    url
}

#[test]
fn a_second_send_reuses_the_connection_the_first_left_open() {
    let h = Harness::new();
    let url = keep_alive_server(2);

    let first = send_get(&h, &url);
    let second = send_get(&h, &url);

    assert_eq!(first["timings"]["reused"], false, "{}", first["timings"]);
    assert_eq!(second["timings"]["reused"], true, "{}", second["timings"]);
    assert_eq!(second["bodyText"], "ok");
}
