//! End-to-end IPC tests: invoke the real command handlers with the same JSON
//! payloads the frontend sends (camelCase args, frontend-only `_key` fields),
//! covering the vertical slice open → edit → toggle → send → save → reopen.

mod confinement;
mod paths;
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

struct Harness {
    _app: tauri::App<tauri::test::MockRuntime>,
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    /// This app's settings folder; deleted when the harness is dropped.
    cfg: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let cfg = tempfile::tempdir().unwrap();
        let builder = mock_builder().manage(super::ConfigDir(cfg.path().to_path_buf()));
        let app = super::with_commands(builder).build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        Harness { _app: app, webview, cfg }
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
        let body = br#"{"ok":true}"#;
        let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n", body.len());
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
    assert_eq!(resp["warnings"][0], "Unresolved variables: token");
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
    assert!(text.ends_with("### Untouched\n// hand formatted\nGET   https://example.com\n"), "untouched request kept byte-for-byte: {text}");

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

#[test]
fn errors_are_strings() {
    let h = Harness::new();
    let err = h.call("get_tree", json!({})).unwrap_err();
    assert_eq!(err, json!("No workspace is open"));
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

/// Paths reported by `workspace-changed` until no event has arrived for `quiet`.
fn changed_paths(rx: &mpsc::Receiver<String>, quiet: std::time::Duration) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(payload) = rx.recv_timeout(quiet) {
        let v: Value = serde_json::from_str(&payload).unwrap();
        out.extend(v["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()));
    }
    out
}

/// Delete isn't driven here: on macOS `trash` asks Finder, which would move test
/// folders into the user's real Trash. It uses the same "absent" expectation as a move's source.
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

    let p = |rel: &str| root.join(rel).to_string_lossy().to_string();
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
