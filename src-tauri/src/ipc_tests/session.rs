//! The workspace Session over IPC: prompt answers are remembered per request key in
//! the shell, reach the preview and the send, and are forgotten on demand and when
//! another workspace opens. Cookies set by one send are sent on the next, and
//! another workspace starts with an empty jar. Nothing in the Session is ever
//! written to disk.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{capture_server, Harness};

/// A workspace whose `api.http` asks for `otp` and `password` and sends them to `server`.
fn prompting_workspace(h: &Harness, server: &str) -> (tempfile::TempDir, PathBuf, Value) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let file_path = root.join("api.http");
    let text =
        format!("# @prompt otp\n# @prompt password\nGET {server}/login?otp={{{{otp}}}}\nX-Pass: {{{{password}}}}\n");
    std::fs::write(&file_path, &text).unwrap();
    std::fs::write(root.join("http-client.env.json"), json!({ "local": { "otp": "env" } }).to_string()).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let args = json!({
        "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": "local", "requestKey": "k1"
    });
    (ws, file_path, args)
}

#[test]
fn prompt_answers_reach_the_preview_and_the_send_and_are_never_written() {
    let h = Harness::new();
    let (server, received) = capture_server();
    let (ws, file_path, mut args) = prompting_workspace(&h, &server);
    let text = std::fs::read_to_string(&file_path).unwrap();

    // Unanswered: shown as written, not as Undefined variables.
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["url"], format!("{server}/login?otp={{{{otp}}}}"));
    assert_eq!(shown["warnings"], json!([]));

    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "123456", "password": "s3cret" } }));
    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k1" })), json!({ "otp": "123456", "password": "s3cret" }));
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["url"], format!("{server}/login?otp=123456"), "over the environment's otp");
    assert!(shown["headers"].as_array().unwrap().contains(&json!(["X-Pass", "••••••••"])), "masked: {shown}");

    args["runId"] = json!("r1");
    h.ok("send_request", args);
    let raw = received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(raw.starts_with("GET /login?otp=123456 HTTP/1.1"), "{raw}");
    assert!(raw.contains("x-pass: s3cret") || raw.contains("X-Pass: s3cret"), "{raw}");

    // Nothing on disk holds a prompted value: not the .http file, env files or settings.
    for dir in [ws.path(), h.config_dir().as_path()] {
        for entry in walkdir(dir) {
            let bytes = std::fs::read(&entry).unwrap_or_default();
            let content = String::from_utf8_lossy(&bytes);
            assert!(
                !content.contains("123456") && !content.contains("s3cret"),
                "{} holds a prompted value",
                entry.display()
            );
        }
    }
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), text);
}

#[test]
fn prompt_answers_belong_to_one_request() {
    let h = Harness::new();
    let (_ws, _, mut args) = prompting_workspace(&h, "http://127.0.0.1:9");
    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "123456" } }));

    args["requestKey"] = json!("k2");
    let shown = h.ok("preview_request", args);
    assert_eq!(shown["url"], "http://127.0.0.1:9/login?otp={{otp}}", "another request's answers aren't used");
    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k2" })), json!({}));
}

#[test]
fn forgetting_prompt_answers_asks_again() {
    let h = Harness::new();
    let (_ws, _, args) = prompting_workspace(&h, "http://127.0.0.1:9");
    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "123456" } }));

    h.ok("forget_prompt_answers", json!({ "requestKey": "k1" }));

    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k1" })), json!({}));
    assert_eq!(h.ok("preview_request", args)["url"], "http://127.0.0.1:9/login?otp={{otp}}");
}

#[test]
fn opening_another_workspace_forgets_every_prompt_answer() {
    let h = Harness::new();
    let (_first, _, _) = prompting_workspace(&h, "http://127.0.0.1:9");
    h.ok("answer_prompts", json!({ "requestKey": "k1", "answers": { "otp": "123456" } }));
    h.ok("answer_prompts", json!({ "requestKey": "k2", "answers": { "password": "s3cret" } }));

    let (_second, _, args) = prompting_workspace(&h, "http://127.0.0.1:9");

    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k1" })), json!({}));
    assert_eq!(h.ok("prompt_answers", json!({ "requestKey": "k2" })), json!({}));
    assert_eq!(h.ok("preview_request", args)["url"], "http://127.0.0.1:9/login?otp={{otp}}");
}

/// A one-shot server answering 200 with `set_cookie` (if any) as its Set-Cookie;
/// the receiver gets the raw request it received.
fn cookie_server(set_cookie: Option<&'static str>) -> (String, std::sync::mpsc::Receiver<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
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
        let cookie = set_cookie.map(|c| format!("set-cookie: {c}\r\n")).unwrap_or_default();
        let _ = write!(stream, "HTTP/1.1 200 OK\r\n{cookie}content-length: 0\r\n\r\n");
        tx.send(String::from_utf8_lossy(&buf).into_owned()).unwrap();
    });
    (url, rx)
}

/// Opens `root` if it isn't open yet, then sends `GET {url}/x` from a file in it
/// and returns the raw request the server received.
fn send_to(h: &Harness, root: &Path, (url, received): (String, std::sync::mpsc::Receiver<String>)) -> String {
    let path = root.join("cookies.http");
    std::fs::write(&path, format!("GET {url}/x\n")).unwrap();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let args = json!({ "runId": "c", "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": null });
    h.ok("send_request", args);
    received.recv_timeout(std::time::Duration::from_secs(5)).unwrap().to_ascii_lowercase()
}

#[test]
fn cookies_are_sent_back_within_a_workspace_never_written_and_forgotten_when_another_opens() {
    let h = Harness::new();
    let first = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(first.path()).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    send_to(&h, &root, cookie_server(Some("sid=s3cret-sid; Path=/")));
    // Another port on the same host: cookies don't tell ports apart.
    let raw = send_to(&h, &root, cookie_server(None));
    assert!(raw.contains("cookie: sid=s3cret-sid"), "{raw}");

    let second = tempfile::tempdir().unwrap();
    let other = crate::paths::canonicalize(second.path()).unwrap();
    h.ok("open_workspace", json!({ "path": other }));
    let raw = send_to(&h, &other, cookie_server(None));
    assert!(!raw.contains("cookie:"), "the new workspace's Session started with the old jar: {raw}");

    for dir in [first.path(), second.path(), h.config_dir().as_path()] {
        for entry in walkdir(dir) {
            let content = String::from_utf8_lossy(&std::fs::read(&entry).unwrap_or_default()).into_owned();
            assert!(!content.contains("s3cret-sid"), "{} holds a cookie", entry.display());
        }
    }
}

/// Every file under `dir`.
fn walkdir(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walkdir(&path));
        } else {
            out.push(path);
        }
    }
    out
}
