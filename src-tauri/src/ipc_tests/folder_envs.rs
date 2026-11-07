//! Per-directory environment files (ADR-0004) over IPC: each request is sent and
//! previewed with the environments its own folder chain defines.

use serde_json::{json, Value};

use super::{capture_server, Harness};

/// The first request of the `.http` file at `path`, as the frontend sends it.
fn send_args(h: &Harness, path: &std::path::Path, environment: &str) -> Value {
    let path = path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    json!({ "runId": path, "request": file["requests"][0], "filePath": path, "fileVariables": [], "environment": environment })
}

#[test]
fn requests_in_sibling_folders_send_with_their_own_folders_environment() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (users_server, users_received) = capture_server();
    let (billing_server, billing_received) = capture_server();
    std::fs::write(root.join("http-client.env.json"), json!({ "$shared": { "version": "v1" } }).to_string()).unwrap();
    for (dir, server) in [("users", &users_server), ("billing", &billing_server)] {
        std::fs::create_dir(root.join(dir)).unwrap();
        std::fs::write(root.join(dir).join("api.http"), "GET {{baseUrl}}/{{version}}/list\n").unwrap();
        std::fs::write(
            root.join(dir).join("http-client.env.json"),
            json!({ "dev": { "baseUrl": server } }).to_string(),
        )
        .unwrap();
    }
    h.ok("open_workspace", json!({ "path": root }));

    for (dir, server, received) in
        [("users", &users_server, &users_received), ("billing", &billing_server, &billing_received)]
    {
        let args = send_args(&h, &root.join(dir).join("api.http"), "dev");
        let shown = h.ok("preview_request", args.clone());
        assert_eq!(shown["url"], format!("{server}/v1/list"), "{dir} previews with its own dev");
        let sent = h.ok("send_request", args);
        assert_eq!(sent["status"], 200);
        let raw = received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert!(raw.starts_with("GET /v1/list HTTP/1.1"), "{dir}: {raw}");
        assert_eq!(sent["warnings"], json!([]));
    }

    // The frontend gets each folder's environments, for picking a request's own.
    let folders = h.ok("load_folder_environments", json!({}));
    let dirs: Vec<_> = folders.as_array().unwrap().iter().map(|f| f["dir"].as_str().unwrap()).collect();
    assert_eq!(dirs, ["billing", "users"]);
    assert_eq!(folders[1]["set"]["environments"][0]["variables"][0]["value"], json!(users_server));
    assert_eq!(folders[1]["set"]["shared"][0]["name"], "version");
}

#[test]
fn an_environment_the_folder_doesnt_define_sends_with_no_environment_and_says_so() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let (server, received) = capture_server();
    std::fs::create_dir_all(root.join("api/users")).unwrap();
    std::fs::create_dir(root.join("billing")).unwrap();
    let file = root.join("api/users/users.http");
    std::fs::write(&file, format!("GET {server}/users?v={{{{version}}}}\nX-Host: {{{{host}}}}\n")).unwrap();
    std::fs::write(root.join("http-client.env.json"), json!({ "$shared": { "version": "v1" } }).to_string()).unwrap();
    // `staging` exists, but only for billing: it's never borrowed.
    std::fs::write(root.join("billing/http-client.env.json"), json!({ "staging": { "host": "billing" } }).to_string())
        .unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let args = send_args(&h, &file, "staging");
    let warning = "Environment \"staging\" isn't defined for api/users/, so it's sent with no environment";
    let shown = h.ok("preview_request", args.clone());
    assert_eq!(shown["url"], format!("{server}/users?v=v1"), "$shared still applies");
    assert_eq!(shown["warnings"][0], warning);

    let sent = h.ok("send_request", args);
    received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(sent["warnings"], json!([warning, "Unresolved variables: host"]));
}
