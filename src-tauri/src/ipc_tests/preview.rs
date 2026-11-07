//! `preview_request`: the resolved preview under the URL bar, over IPC with
//! frontend-shaped JSON. It must agree with what `send_request` sends.

use serde_json::json;

use super::{capture_server, Harness};

#[test]
fn preview_request_shows_what_send_request_sends() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, received) = capture_server();
    let file_path = root.join("api.http");
    std::fs::write(
        &file_path,
        "@page = 2\n\n### Create\nPOST {{baseUrl}}/items?page={{page}}&q={{query}}\nAuthorization: Bearer {{token}}\n\n{\"id\": \"{{id}}\"}\n",
    )
    .unwrap();
    std::fs::write(
        root.join("http-client.env.json"),
        json!({ "$shared": { "query": "a&b" }, "local": { "baseUrl": server, "token": "" } }).to_string(),
    )
    .unwrap();
    std::fs::write(root.join("http-client.private.env.json"), json!({ "local": { "token": "s3cret" } }).to_string())
        .unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let path = file_path.to_string_lossy().to_string();
    let mut file = h.ok("read_http_file", json!({ "path": path }));
    file["requests"][0]["_key"] = json!("k1");
    let request = file["requests"][0].clone();
    let file_variables = file["header"]["variables"].clone();
    let args = json!({ "request": request, "filePath": path, "fileVariables": file_variables, "environment": "local" });

    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["method"], "POST");
    assert_eq!(shown["url"], format!("{server}/items?page=2&q=a%26b"));
    assert_eq!(shown["auth"], json!([["Token", "s3cret"]]), "the Secret from the private file");
    assert_eq!(shown["warnings"], json!(["Unresolved variables: id"]));
    assert_eq!(shown["error"], json!(null));
    let headers = shown["headers"].as_array().unwrap();
    assert!(headers.contains(&json!(["Authorization", "Bearer s3cret"])), "{headers:?}");
    assert!(headers.contains(&json!(["Content-Type", "application/json"])), "implied by the body: {headers:?}");

    let mut send = args.clone();
    send["runId"] = json!("r1");
    let sent = h.ok("send_request", send);
    received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        (&shown["method"], &shown["url"], &shown["headers"]),
        (&sent["request"]["method"], &sent["request"]["url"], &sent["request"]["headers"])
    );

    // A body file that doesn't exist isn't read, so the preview still works.
    let mut args = args;
    args["request"]["body"]["text"] = json!("< ./missing.json");
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["error"], json!(null));
    assert!(shown["headers"].as_array().unwrap().contains(&json!(["Content-Type", "application/json"])));

    // No environment: the undefined host is the reason it can't be sent, classified like a send error.
    args["environment"] = json!(null);
    let shown = h.ok("preview_request", args);
    assert_eq!(shown["url"], "{{baseUrl}}/items?page=2&q=a%26b", "shared variables still apply");
    assert_eq!(shown["error"]["kind"], "unresolvedVariable");
    assert_eq!(shown["error"]["details"]["names"], json!(["baseUrl"]));
}

#[test]
fn prompted_values_reach_the_preview_and_the_send_and_are_never_written() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, received) = capture_server();
    let file_path = root.join("api.http");
    let text =
        format!("# @prompt otp\n# @prompt password\nGET {server}/login?otp={{{{otp}}}}\nX-Pass: {{{{password}}}}\n");
    std::fs::write(&file_path, &text).unwrap();
    std::fs::write(root.join("http-client.env.json"), json!({ "local": { "otp": "env" } }).to_string()).unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let mut args =
        json!({ "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": "local" });

    // Unanswered: shown as written, not as Undefined variables.
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["url"], format!("{server}/login?otp={{{{otp}}}}"));
    assert_eq!(shown["warnings"], json!([]));

    args["promptValues"] = json!({ "otp": "123456", "password": "s3cret" });
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["url"], format!("{server}/login?otp=123456"), "over the environment's otp");
    assert!(shown["headers"].as_array().unwrap().contains(&json!(["X-Pass", "••••••••"])), "masked: {shown}");

    args["runId"] = json!("r1");
    h.ok("send_request", args);
    let raw = received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(raw.starts_with("GET /login?otp=123456 HTTP/1.1"), "{raw}");
    assert!(raw.contains("x-pass: s3cret") || raw.contains("X-Pass: s3cret"), "{raw}");

    // Nothing on disk holds a prompted value: not the .http file, env files or settings.
    for dir in [root.as_path(), h.config_dir().as_path()] {
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

/// Every file under `dir`.
fn walkdir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
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
