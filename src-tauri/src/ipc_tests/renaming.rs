//! Rename variable (#86) over IPC: the frontend renames the variable in the
//! environment set and the `{{name}}` references Find usages found, then saves
//! with `save_environments` and `save_http_file`. These writes keep Secrets in the
//! private file, keep untouched requests byte-for-byte, and aren't reported back by
//! the watcher as external changes.

use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Listener;

use super::{changed_paths, Harness};

/// Replaces `{{token}}` with `{{apiToken}}` in a JSON string, as the frontend does at a usage.
fn renamed(v: &Value) -> Value {
    json!(v.as_str().unwrap().replace("{{token}}", "{{apiToken}}"))
}

#[test]
fn renaming_a_secret_across_files_keeps_it_private_and_untouched_requests_byte_for_byte_and_is_not_reported() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    // The requests around the one that uses it are written oddly (comments, spacing),
    // so a re-render of either would show.
    let before = "# First\n###   Before  \nGET   https://x/0?q=1\nX-Odd:  value\n\n";
    let uses = "### Uses it\nGET https://x/a\nAuthorization: Bearer {{token}}\n\n";
    let after = "###   After\n# keep me\nGET   https://x/b\n";
    let a = format!("{before}{uses}{after}");
    let b = "@auth = Bearer {{token}}\n\n### Header var\nGET https://x/c\nAuthorization: {{auth}}\n";
    std::fs::write(root.join("a.http"), a).unwrap();
    std::fs::write(root.join("b.http"), b).unwrap();
    std::fs::write(root.join("http-client.env.json"), json!({ "dev": { "host": "https://x" } }).to_string()).unwrap();
    std::fs::write(root.join("http-client.private.env.json"), json!({ "dev": { "token": "s3cret" } }).to_string())
        .unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    let (tx, rx) = mpsc::channel::<String>();
    h.webview.listen_any("workspace-changed", move |e| {
        let _ = tx.send(e.payload().to_string());
    });
    changed_paths(&rx, Duration::from_millis(600));

    // The environments, renamed.
    let mut set = h.ok("load_environments", json!({}));
    let vars = set["environments"][0]["variables"].as_array_mut().unwrap();
    let token = vars.iter_mut().find(|v| v["name"] == "token").unwrap();
    assert_eq!(token["secret"], json!(true));
    token["name"] = json!("apiToken");
    h.ok("save_environments", json!({ "set": set }));

    // a.http: a request's auth token; b.http: a File variable.
    let pa = root.join("a.http").to_string_lossy().to_string();
    let mut fa = h.ok("read_http_file", json!({ "path": pa }));
    let token = &mut fa["requests"][1]["auth"]["token"];
    *token = renamed(token);
    fa["requests"][1]["_key"] = json!("k1"); // frontend-only identity, as the app sends it
    h.ok("save_http_file", json!({ "path": pa, "file": fa }));
    let pb = root.join("b.http").to_string_lossy().to_string();
    let mut fb = h.ok("read_http_file", json!({ "path": pb }));
    let value = &mut fb["header"]["variables"][0]["value"];
    *value = renamed(value);
    h.ok("save_http_file", json!({ "path": pb, "file": fb }));

    let saved = std::fs::read_to_string(root.join("a.http")).unwrap();
    assert!(saved.starts_with(before) && saved.ends_with(after), "untouched requests changed:\n{saved}");
    assert!(saved.contains("Authorization: Bearer {{apiToken}}\n") && !saved.contains("{{token}}"), "{saved}");
    assert_eq!(std::fs::read_to_string(root.join("b.http")).unwrap(), b.replace("{{token}}", "{{apiToken}}"));
    let public: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("http-client.env.json")).unwrap()).unwrap();
    let private: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("http-client.private.env.json")).unwrap()).unwrap();
    assert_eq!(public, json!({ "dev": { "host": "https://x" } }));
    assert_eq!(private, json!({ "dev": { "apiToken": "s3cret" } }));

    let reported = changed_paths(&rx, Duration::from_secs(2));
    assert!(reported.is_empty(), "the rename's own writes were reported as external changes: {reported:?}");
}
