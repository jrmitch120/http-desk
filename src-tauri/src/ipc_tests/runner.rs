//! Runs over IPC: `run_requests` sends a file's requests in order, reporting each as
//! `run-progress` events whose responses the viewer can fetch, and `cancel_request`
//! stops it, the request in flight included. Its options: a delay between requests,
//! and stop on first failure.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Listener, Manager};

use super::{fetch, Harness};

/// A server answering each request on its own connection: `/hang` never answers,
/// anything else gets 200 with its path as the body. Each request's path is sent on
/// the channel as it arrives.
fn path_server() -> (String, mpsc::Receiver<String>) {
    let (url, timed) = timed_path_server();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for (path, _) in timed {
            if tx.send(path).is_err() {
                return;
            }
        }
    });
    (url, rx)
}

/// `path_server`, also giving the moment each request arrived.
fn timed_path_server() -> (String, mpsc::Receiver<(String, Instant)>) {
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
                let _ = tx.send((path.clone(), Instant::now()));
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
    let ws = tempfile::tempdir().unwrap();
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

    assert_eq!(summary, json!({ "cancelled": false }));
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
    assert_eq!(summary, json!({ "cancelled": true }));
    assert_eq!(
        states(&events.try_iter().collect::<Vec<_>>()),
        vec![(0, "sending".into()), (0, "sent".into()), (1, "sending".into()), (1, "cancelled".into())]
    );
    assert!(received.recv_timeout(Duration::from_millis(300)).is_err(), "nothing after the stopped request is sent");
}

#[test]
fn runner_options_are_remembered_per_workspace_across_a_restart() {
    let h = Harness::new();
    let (ws, _) = workspace(&h, "GET http://localhost/\n");
    let ws_key = crate::paths::canonicalize(ws.path()).unwrap().to_string_lossy().to_string();

    let mut settings = h.ok("get_settings", json!({}));
    assert_eq!(settings["runnerOptions"], json!({}));
    settings["runnerOptions"] = json!({ ws_key.clone(): { "delayMs": 250, "stopOnFailure": true } });
    h.ok("save_settings", json!({ "settings": settings }));

    // A restart: the defaults, then whatever settings.json holds.
    *h.app.state::<crate::AppState>().settings.lock().unwrap() = crate::AppSettings::default();
    crate::load_settings(h.app.handle());
    let reloaded = h.ok("get_settings", json!({}));
    assert_eq!(reloaded["runnerOptions"][&ws_key], json!({ "delayMs": 250, "stopOnFailure": true }));
}

#[test]
fn with_a_delay_the_requests_arrive_at_least_that_far_apart() {
    let h = Harness::new();
    let (url, received) = timed_path_server();
    let (_ws, selection) = workspace(&h, &format!("GET {url}/one\n\n###\nGET {url}/two\n\n###\nGET {url}/three\n"));

    let summary =
        h.ok("run_requests", json!({ "runId": "run3", "selection": selection, "options": { "delayMs": 300 } }));

    assert_eq!(summary, json!({ "cancelled": false }));
    let arrivals: Vec<(String, Instant)> = received.try_iter().collect();
    let paths: Vec<&str> = arrivals.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, ["/one", "/two", "/three"]);
    // A lower bound only: timers never fire early, but how late they are depends on load.
    // The tolerance covers the clock's granularity.
    for pair in arrivals.windows(2) {
        let gap = pair[1].1 - pair[0].1;
        assert!(gap >= Duration::from_millis(290), "{} came {gap:?} after {}", pair[1].0, pair[0].0);
    }
}

#[test]
fn with_stop_on_first_failure_a_run_ends_at_the_first_failure_and_sends_nothing_after_it() {
    let h = Harness::new();
    let (url, received) = path_server();
    // Nothing listens on `refused` once its listener is dropped: a network error.
    let refused = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let text = format!("GET {url}/one\n\n###\nGET http://{refused}/down\n\n###\nGET {url}/three\n");
    let (_ws, selection) = workspace(&h, &text);
    let events = progress_events(&h);

    let summary =
        h.ok("run_requests", json!({ "runId": "run4", "selection": selection, "options": { "stopOnFailure": true } }));

    assert_eq!(summary, json!({ "cancelled": false }));
    assert_eq!(
        states(&events.try_iter().collect::<Vec<_>>()),
        vec![(0, "sending".into()), (0, "sent".into()), (1, "sending".into()), (1, "failed".into())]
    );
    assert_eq!(received.try_iter().collect::<Vec<_>>(), ["/one"], "nothing after the failure is sent");
}
