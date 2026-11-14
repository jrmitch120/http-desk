//! Runs over IPC: `run_requests` sends a file's requests in order, reporting each as
//! `run-progress` events whose responses the viewer can fetch, and `cancel_request`
//! stops it, the request in flight included.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Listener;

use super::{fetch, Harness};

/// A server answering each request on its own connection: `/hang` never answers,
/// anything else gets 200 with its path as the body. Each request's path is sent on
/// the channel as it arrives.
fn path_server() -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let _ = tx.send(path.clone());
                if path == "/hang" {
                    std::thread::sleep(Duration::from_secs(30));
                    return;
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{path}",
                    path.len()
                );
            });
        }
    });
    (url, rx)
}

/// Opens a workspace whose `api.http` is `text`, and returns it (kept until dropped)
/// with the `run_requests` selection of all its requests.
fn workspace(h: &Harness, text: &str) -> (tempfile::TempDir, Value) {
    workspace_in(h, tempfile::tempdir().unwrap(), text)
}

/// [`workspace`] in `ws`, which may already hold env files.
fn workspace_in(h: &Harness, ws: tempfile::TempDir, text: &str) -> (tempfile::TempDir, Value) {
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    let file_path = root.join("api.http");
    std::fs::write(&file_path, text).unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    let path = file_path.to_string_lossy().to_string();
    let file = h.ok("read_http_file", json!({ "path": path }));
    let requests: Vec<Value> = file["requests"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({ "request": r, "filePath": path, "fileVariables": [], "requestNames": [], "requestKey": format!("k{i}") })
        })
        .collect();
    (ws, json!({ "requests": requests, "environment": null }))
}

/// Every `run-progress` event, as it's emitted.
fn progress_events(h: &Harness) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    h.webview.listen_any("run-progress", move |e| {
        let _ = tx.send(serde_json::from_str::<Value>(e.payload()).unwrap());
    });
    rx
}

/// `(index, state)` of each event.
fn states(events: &[Value]) -> Vec<(u64, String)> {
    events.iter().map(|e| (e["index"].as_u64().unwrap(), e["state"].as_str().unwrap().to_string())).collect()
}

#[test]
fn a_run_reports_each_request_in_order_and_keeps_each_response_for_the_viewer() {
    let h = Harness::new();
    let (url, _) = path_server();
    let (_ws, selection) = workspace(&h, &format!("GET {url}/one\n\n###\nGET {url}/two\n"));
    let events = progress_events(&h);

    let summary = h.ok("run_requests", json!({ "runId": "run1", "selection": selection, "options": {} }));

    assert_eq!(summary["cancelled"], false);
    let events: Vec<Value> = events.try_iter().collect();
    assert_eq!(
        states(&events),
        vec![(0, "sending".into()), (0, "sent".into()), (1, "sending".into()), (1, "sent".into())]
    );
    assert!(events.iter().all(|e| e["runId"] == "run1"));
    let sent = &events[3];
    assert_eq!(sent["failed"], false);
    assert_eq!(sent["response"]["status"], 200);
    assert_eq!(fetch::fetch(&h, &sent["response"]["id"], "raw").unwrap(), b"/two");
}

#[test]
fn stopping_a_run_cancels_the_request_in_flight_and_sends_nothing_after_it() {
    let h = Harness::new();
    let (url, received) = path_server();
    let (_ws, selection) = workspace(&h, &format!("GET {url}/one\n\n###\nGET {url}/hang\n\n###\nGET {url}/three\n"));
    let events = progress_events(&h);

    let webview = h.webview.clone();
    let run = std::thread::spawn(move || {
        super::call_on(&webview, "run_requests", json!({ "runId": "run2", "selection": selection }))
    });
    assert_eq!(received.recv_timeout(Duration::from_secs(5)).unwrap(), "/one");
    assert_eq!(received.recv_timeout(Duration::from_secs(5)).unwrap(), "/hang");
    h.ok("cancel_request", json!({ "runId": "run2" }));

    let summary = run.join().unwrap().unwrap();
    assert_eq!(summary["cancelled"], true);
    let outcomes: Vec<&Value> = summary["requests"].as_array().unwrap().iter().map(|r| &r["outcome"]).collect();
    assert_eq!(outcomes, [&json!("passed"), &json!("cancelled"), &json!("notRun")], "every request is reported");
    assert_eq!(
        states(&events.try_iter().collect::<Vec<_>>()),
        vec![(0, "sending".into()), (0, "sent".into()), (1, "sending".into()), (1, "cancelled".into())]
    );
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing after the stopped request is sent");
}

#[test]
fn a_finished_run_exports_as_junit_and_json_with_no_secret_value_or_response_body() {
    let h = Harness::new();
    let (url, _) = path_server();
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("http-client.env.json"), json!({ "dev": { "host": url } }).to_string()).unwrap();
    let private = json!({ "dev": { "token": "TOPSECRET42" } }).to_string();
    std::fs::write(ws.path().join("http-client.private.env.json"), private).unwrap();
    // The server answers with the path it got: the second body holds the Secret.
    let text = "### Me\nGET {{host}}/me\nAuthorization: Bearer {{token}}\n\n###\nGET {{host}}/keys/{{token}}\n";
    let (_ws, mut selection) = workspace_in(&h, ws, text);
    selection["environment"] = json!("dev");

    let summary = h.ok("run_requests", json!({ "runId": "run3", "selection": selection }));

    let requests = &summary["requests"];
    assert_eq!(requests.as_array().unwrap().len(), 2);
    assert_eq!(
        (&requests[0]["name"], &requests[0]["file"], &requests[0]["status"]),
        (&json!("Me"), &json!("api.http"), &json!(200))
    );
    let out = tempfile::tempdir().unwrap();
    for format in ["junit", "json"] {
        let path = out.path().join(format!("run.{format}"));
        h.ok("export_run", json!({ "requests": requests, "format": format, "path": path }));
        let exported = std::fs::read_to_string(&path).unwrap();
        assert!(exported.contains("api.http") && exported.contains("Me"), "{format}: {exported}");
        assert!(!exported.contains("TOPSECRET42"), "{format} holds the Secret: {exported}");
    }
    let junit = std::fs::read_to_string(out.path().join("run.junit")).unwrap();
    assert!(junit.starts_with("<?xml") && junit.contains("<testsuite name=\"api.http\""), "{junit}");
    let json: Value = serde_json::from_str(&std::fs::read_to_string(out.path().join("run.json")).unwrap()).unwrap();
    assert_eq!(json["requests"][1]["url"], format!("{url}/keys/••••••••"));
}
