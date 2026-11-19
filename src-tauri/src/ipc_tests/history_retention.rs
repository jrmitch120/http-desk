//! History kept bounded (#155): a fixed 10 MB cap per body, retention limits (count
//! per request and age within a workspace, one total size across workspaces, oldest
//! first), and deleting an entry or a workspace's History from disk.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;

use serde_json::{json, Value};

use super::fetch::fetch;
use super::history::{all_history, request, send_args, send_in, store_bytes, the_entry, workspace};
use super::Harness;

/// The body cap: 10 MB.
const CAP: usize = 10 * 1024 * 1024;

/// Answers every request (reading its whole body first) with `content_type` and
/// `body`, one per connection, on any number of connections.
fn serve(content_type: &'static str, body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().map_while(Result::ok) {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 64 * 1024];
            let head_end = loop {
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(i + 4);
                }
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break None,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            };
            let Some(head_end) = head_end else { continue };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .map_or(0, |v| v.trim().parse().unwrap_or(0));
            while buf.len() < head_end + length {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let reply = format!(
                "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).and_then(|_| stream.write_all(&body));
        }
    });
    url
}

/// `len` bytes that don't compress: History's store compresses bodies.
fn noise(len: usize) -> Vec<u8> {
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 32) as u8
        })
        .collect()
}

/// `len` bytes of text that don't compress.
fn text_noise(len: usize) -> Vec<u8> {
    noise(len).into_iter().map(|b| b"abcdefghijklmnopqrstuvwxyz0123456789"[b as usize % 36]).collect()
}

#[test]
fn a_text_body_over_10_mb_is_kept_cut_off_at_10_mb_and_marked_truncated() {
    let h = Harness::new();
    let body = text_noise(CAP + 1000);
    let url = serve("text/plain", body.clone());
    let (_ws, root) = workspace(&h, &format!("GET {url}/big\n"));
    let sent = h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    assert_eq!(sent["bodySize"], CAP + 1000);

    let opened = the_entry(&h);
    assert_eq!(opened["bodyKept"], "truncated");
    assert_eq!(opened["response"]["bodySize"], CAP + 1000, "the size as received");
    assert_eq!(fetch(&h, &opened["response"]["id"], "raw").unwrap(), &body[..CAP]);
    assert_eq!(all_history(&h)[0]["size"], CAP + 1000);
}

#[test]
fn a_body_within_10_mb_is_kept_whole() {
    let h = Harness::new();
    let body = text_noise(CAP);
    let url = serve("text/plain", body.clone());
    let (_ws, root) = workspace(&h, &format!("GET {url}/fits\n"));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));

    let opened = the_entry(&h);
    assert_eq!(opened["bodyKept"], "whole");
    assert_eq!(fetch(&h, &opened["response"]["id"], "raw").unwrap(), body);
}

#[test]
fn a_binary_body_over_10_mb_keeps_only_its_headers_and_size() {
    let h = Harness::new();
    let url = serve("image/png", noise(CAP + 1));
    let (_ws, root) = workspace(&h, &format!("GET {url}/huge.png\n"));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));

    let opened = the_entry(&h);
    assert_eq!(opened["bodyKept"], "headersOnly");
    let response = &opened["response"];
    assert_eq!((&response["status"], &response["bodySize"]), (&json!(200), &json!(CAP + 1)));
    assert!(response["headers"].as_array().unwrap().contains(&json!(["content-type", "image/png"])), "{response}");
    assert!(fetch(&h, &response["id"], "raw").is_err(), "no body to show");
    assert!(store_bytes(&h.config_dir()).len() < 1024 * 1024, "the body isn't in the store");
}

/// The request body kept in the store for the newest entry, and whether it's marked cut off.
fn stored_request_body(cfg: &Path) -> (String, bool) {
    let conn = rusqlite::Connection::open(cfg.join(crate::history::FILE_NAME)).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let request: String =
        conn.query_row("SELECT request FROM entries ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    let request: Value = serde_json::from_str(&request).unwrap();
    (request["bodyPreview"].as_str().unwrap().to_string(), request["bodyTruncated"] == true)
}

#[test]
fn the_request_as_sent_keeps_its_body_up_to_10_mb_marked_truncated_past_it_and_opened_shows_the_live_preview() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let (_ws, root) = workspace(
        &h,
        &format!("POST {url}/small\nContent-Type: text/plain\n\n< ./small.txt\n\n###\nPOST {url}/upload\nContent-Type: text/plain\n\n< ./big.txt\n"),
    );
    let big = text_noise(CAP + 10);
    std::fs::write(root.join("big.txt"), &big).unwrap();
    let small = text_noise(100 * 1024);
    std::fs::write(root.join("small.txt"), &small).unwrap();

    let sent = h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    let preview = sent["request"]["bodyPreview"].as_str().unwrap();
    assert!(preview.len() < small.len(), "the live preview stays short");
    let entries = all_history(&h);
    let opened = h.ok("open_history_entry", json!({ "id": entries[0]["id"] }));
    assert_eq!(stored_request_body(&h.config_dir()), (String::from_utf8(small).unwrap(), false), "kept whole");
    assert_eq!(opened["request"]["bodyPreview"], preview, "the reply carries the live send's preview");
    assert_eq!(opened["request"]["bodySize"], 100 * 1024);
    assert_eq!(opened["request"]["bodyTruncated"], Value::Null, "the preview stops short, but History kept it whole");
    assert_eq!(opened["response"]["request"], opened["request"]);

    let sent = h.ok("send_request", send_args(&root, &request(&h, &root, 1)));
    let entries = all_history(&h);
    let opened = h.ok("open_history_entry", json!({ "id": entries[0]["id"] }));
    let (stored, cut_off) = stored_request_body(&h.config_dir());
    assert_eq!((stored.as_bytes(), cut_off), (&big[..CAP], true), "kept up to 10 MB, marked cut off");
    let request = &opened["request"];
    assert_eq!(request["bodySize"], CAP + 10);
    assert_eq!(request["bodyPreview"], sent["request"]["bodyPreview"]);
    assert_eq!(request["bodyTruncated"], true, "cut off at 10 MB");
    assert_eq!(opened["response"]["request"], opened["request"]);
}

#[test]
fn an_opened_entrys_request_body_that_masking_brings_under_64_kb_shows_whole_without_a_total() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let padding = "a".repeat(64 * 1024 - 100);
    let (_ws, root) =
        workspace(&h, &format!("POST {url}/upload\nContent-Type: text/plain\n\n{{{{token}}}}{padding}\n"));
    std::fs::write(root.join("http-client.env.json"), json!({ "local": { "token": "" } }).to_string()).unwrap();
    let token = "t".repeat(1000);
    std::fs::write(root.join("http-client.private.env.json"), json!({ "local": { "token": token } }).to_string())
        .unwrap();

    let sent = h.ok("send_request", send_in(&root, &request(&h, &root, 0), "local"));
    assert_eq!(sent["request"]["bodySize"], 1000 + padding.len(), "over 64 KB as sent");
    let opened = the_entry(&h);

    assert_eq!(opened["request"]["bodyPreview"], format!("••••••••{padding}"), "the whole body, masked");
    assert_eq!(opened["request"]["bodyTruncated"], Value::Null);
}

#[test]
fn an_opened_entrys_short_request_body_is_whole_and_not_marked_truncated() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let (_ws, root) = workspace(&h, &format!("POST {url}/small\nContent-Type: text/plain\n\nhello\n"));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    let opened = h.ok("open_history_entry", json!({ "id": all_history(&h)[0]["id"] }));
    assert_eq!(opened["request"]["bodyPreview"], "hello");
    assert_eq!(opened["request"]["bodyTruncated"], Value::Null);
}

/// The URLs of the open workspace's entries, newest first.
fn urls(h: &Harness) -> Vec<String> {
    all_history(h).iter().map(|e| e["url"].as_str().unwrap().to_string()).collect()
}

/// Sets History's retention limits, as Settings does (the whole settings object).
fn retain(h: &Harness, limits: Value) {
    let mut settings = h.ok("get_settings", json!({}));
    for (key, value) in limits.as_object().unwrap() {
        settings["history"][key] = value.clone();
    }
    h.ok("save_settings", json!({ "settings": settings }));
}

/// Moves every entry of the store in `cfg` whose URL ends with `suffix` `days` into the past.
fn backdate(cfg: &Path, suffix: &str, days: i64) {
    let conn = rusqlite::Connection::open(cfg.join(crate::history::FILE_NAME)).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let changed = conn
        .execute(
            "UPDATE entries SET time_ms = time_ms - ?1 WHERE sent_url LIKE ?2",
            rusqlite::params![days * 86_400_000, format!("%{suffix}")],
        )
        .unwrap();
    assert!(changed > 0, "no entry ends with {suffix}");
}

#[test]
fn retention_defaults_to_50_per_request_30_days_and_200_mb() {
    let h = Harness::new();
    let history = &h.ok("get_settings", json!({}))["history"];
    assert_eq!(
        (&history["maxPerRequest"], &history["maxAgeDays"], &history["maxSizeMb"]),
        (&json!(50), &json!(30), &json!(200))
    );
}

#[test]
fn retention_keeps_the_newest_entries_of_each_request_within_a_workspace() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    retain(&h, json!({ "maxPerRequest": 2 }));
    let (_ws_a, root_a) = workspace(&h, &format!("# @name one\nGET {url}/one/1\n\n###\nGET {url}/two\n"));
    let one = request(&h, &root_a, 0);
    for n in 1..=3 {
        let mut edited = one.clone();
        edited["url"] = json!(format!("{url}/one/{n}"));
        h.ok("send_request", send_args(&root_a, &edited));
    }
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 1)));
    assert_eq!(urls(&h), [format!("{url}/two"), format!("{url}/one/3"), format!("{url}/one/2")]);

    // Another workspace's request in a file of the same name has its own count.
    let (_ws_b, root_b) = workspace(&h, &format!("# @name one\nGET {url}/one/1\n"));
    h.ok("send_request", send_args(&root_b, &request(&h, &root_b, 0)));
    assert_eq!(urls(&h), [format!("{url}/one/1")]);
    h.ok("open_workspace", json!({ "path": root_a }));
    assert_eq!(urls(&h).len(), 3);

    // Lowered, it applies at once.
    retain(&h, json!({ "maxPerRequest": 1 }));
    assert_eq!(urls(&h), [format!("{url}/two"), format!("{url}/one/3")]);
}

#[test]
fn retention_removes_entries_older_than_the_age_limit() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let (_ws, root) = workspace(&h, &format!("GET {url}/old\n\n###\nGET {url}/recent\n\n###\nGET {url}/new\n"));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    h.ok("send_request", send_args(&root, &request(&h, &root, 1)));
    all_history(&h);
    backdate(&h.config_dir(), "/old", 31);
    backdate(&h.config_dir(), "/recent", 29);

    h.ok("send_request", send_args(&root, &request(&h, &root, 2)));
    assert_eq!(urls(&h), [format!("{url}/new"), format!("{url}/recent")]);

    // Lowered, it applies at once.
    retain(&h, json!({ "maxAgeDays": 7 }));
    assert_eq!(urls(&h), [format!("{url}/new")]);
}

#[test]
fn retention_keeps_all_history_under_one_size_cap_removing_the_oldest_entries_first() {
    let h = Harness::new();
    retain(&h, json!({ "maxSizeMb": 1 }));
    let url = serve("application/octet-stream", noise(400 * 1024));
    let (_ws_a, root_a) = workspace(&h, &format!("GET {url}/a1\n\n###\nGET {url}/a2\n"));
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 0)));
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 1)));
    assert_eq!(urls(&h).len(), 2);

    let (_ws_b, root_b) = workspace(&h, &format!("GET {url}/b1\n"));
    h.ok("send_request", send_args(&root_b, &request(&h, &root_b, 0)));
    assert_eq!(urls(&h), [format!("{url}/b1")]);
    h.ok("open_workspace", json!({ "path": root_a }));
    assert_eq!(urls(&h), [format!("{url}/a2")], "the oldest went first, whatever its workspace");
}

#[test]
fn deleting_an_entry_removes_it_from_disk_and_an_opened_copy_lasts_until_released() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let (_ws, root) = workspace(&h, &format!("GET {url}/keep\n\n###\nGET {url}/gone?q=needle-1\n"));
    h.ok("send_request", send_args(&root, &request(&h, &root, 0)));
    h.ok("send_request", send_args(&root, &request(&h, &root, 1)));
    let gone = all_history(&h)[0]["id"].clone();
    let opened = h.ok("open_history_entry", json!({ "id": gone }));

    h.ok("delete_history_entry", json!({ "id": gone }));

    assert_eq!(urls(&h), [format!("{url}/keep")]);
    let store = store_bytes(&h.config_dir());
    assert!(!store.windows(8).any(|w| w == b"needle-1"), "the entry is gone from disk");
    assert_eq!(h.call("open_history_entry", json!({ "id": gone })).unwrap_err(), "This History entry no longer exists");
    assert_eq!(fetch(&h, &opened["response"]["id"], "raw").unwrap(), b"ok");
}

#[test]
fn clearing_a_workspaces_history_leaves_other_workspaces_history() {
    let h = Harness::new();
    let url = serve("text/plain", b"ok".to_vec());
    let (_ws_a, root_a) = workspace(&h, &format!("GET {url}/a\n"));
    h.ok("send_request", send_args(&root_a, &request(&h, &root_a, 0)));
    let (_ws_b, root_b) = workspace(&h, &format!("GET {url}/b?q=needle-b\n\n###\nGET {url}/b2\n"));
    h.ok("send_request", send_args(&root_b, &request(&h, &root_b, 0)));
    h.ok("send_request", send_args(&root_b, &request(&h, &root_b, 1)));

    h.ok("clear_workspace_history", json!({}));

    assert_eq!(all_history(&h), Vec::<Value>::new());
    assert!(!store_bytes(&h.config_dir()).windows(8).any(|w| w == b"needle-b"), "gone from disk");
    h.ok("open_workspace", json!({ "path": root_a }));
    assert_eq!(urls(&h), [format!("{url}/a")]);
}
