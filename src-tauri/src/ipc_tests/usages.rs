//! `find_usages`: Find usages of a variable, over IPC with frontend-shaped JSON.

use serde_json::json;

use super::Harness;

#[test]
fn find_usages_lists_references_from_disk_open_documents_and_environments() {
    let h = Harness::new();
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    std::fs::write(root.join("a.http"), "### Saved\nGET {{host}}/a\n#~ X-Off: {{host}}\n").unwrap();
    std::fs::write(root.join("b.http"), "### On disk\nGET {{host}}/b\n").unwrap();
    std::fs::write(root.join("http-client.private.env.json"), json!({ "dev": { "token": "{{host}}" } }).to_string())
        .unwrap();
    h.ok("open_workspace", json!({ "path": root }));

    // b.http is open with an unsaved edit that moved the reference into a header.
    let b = root.join("b.http").to_string_lossy().to_string();
    let mut file = h.ok("read_http_file", json!({ "path": b }));
    file["requests"][0]["url"] = json!("https://x/b");
    file["requests"][0]["headers"]["items"] = json!([{ "enabled": true, "name": "Host", "value": "{{ host }}" }]);

    let found = h.ok("find_usages", json!({ "name": "host", "open": [{ "path": b, "file": file }] }));
    let a = root.join("a.http").to_string_lossy().to_string();
    let private = root.join("http-client.private.env.json").to_string_lossy().to_string();
    assert_eq!(
        found,
        json!([
            { "kind": "request", "path": a, "index": 0, "name": "Saved", "method": "GET", "url": "{{host}}/a",
              "field": { "kind": "url" }, "disabled": false, "start": 0, "end": 8 },
            { "kind": "request", "path": a, "index": 0, "name": "Saved", "method": "GET", "url": "{{host}}/a",
              "field": { "kind": "header", "index": 0, "name": "X-Off", "part": "value" }, "disabled": true, "start": 0, "end": 8 },
            { "kind": "request", "path": b, "index": 0, "name": "On disk", "method": "GET", "url": "https://x/b",
              "field": { "kind": "header", "index": 0, "name": "Host", "part": "value" }, "disabled": false, "start": 0, "end": 10 },
            { "kind": "environment", "path": private, "env": "dev", "name": "token", "secret": true, "start": 0, "end": 8 },
        ])
    );
}
