//! `copy_response_body`: Copy body puts a stored body on the clipboard from the
//! shell (text as text, binary as base64), so the webview never holds it. The
//! harness has no clipboard plugin; tests put a recorder in its place.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::Manager;

use super::{send_get, serve_once, Harness};

/// Replaces the clipboard with one that records what's written to it.
fn record_clipboard(h: &Harness) -> Arc<Mutex<Vec<String>>> {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let w = writes.clone();
    h.app.state::<crate::AppState>().clipboard.replace(move |text| {
        w.lock().unwrap().push(text);
        Ok(())
    });
    writes
}

#[test]
fn a_text_body_is_copied_as_text_decoded_from_the_declared_charset() {
    let h = Harness::new();
    let writes = record_clipboard(&h);
    let resp = send_get(&h, &serve_once("text/plain; charset=iso-8859-1", vec![b'c', b'a', b'f', 0xE9]));

    h.ok("copy_response_body", json!({ "responseId": resp["id"] }));
    assert_eq!(*writes.lock().unwrap(), ["café"]);
}

#[test]
fn a_binary_body_is_copied_as_base64() {
    let h = Harness::new();
    let writes = record_clipboard(&h);
    let resp = send_get(&h, &serve_once("image/png", b"\x89PNG\r\n\x1a\n\x00\xff".to_vec()));

    h.ok("copy_response_body", json!({ "responseId": resp["id"] }));
    assert_eq!(*writes.lock().unwrap(), ["iVBORw0KGgoA/w=="]);
}

#[test]
fn a_released_body_is_no_longer_available_and_nothing_is_copied() {
    let h = Harness::new();
    let writes = record_clipboard(&h);
    let resp = send_get(&h, &serve_once("text/plain", b"hello".to_vec()));
    h.ok("release_response", json!({ "responseId": resp["id"] }));

    let err = h.call("copy_response_body", json!({ "responseId": resp["id"] })).unwrap_err();
    assert_eq!(err, json!("Response is no longer available"));
    assert!(writes.lock().unwrap().is_empty());
}

#[test]
fn a_clipboard_that_cant_be_written_fails_the_copy() {
    let h = Harness::new();
    h.app.state::<crate::AppState>().clipboard.replace(|_| Err("The clipboard is locked".into()));
    let resp = send_get(&h, &serve_once("text/plain", b"hello".to_vec()));

    let err = h.call("copy_response_body", json!({ "responseId": resp["id"] })).unwrap_err();
    assert_eq!(err, json!("The clipboard is locked"));
}

#[test]
fn without_the_clipboard_plugin_the_copy_fails_instead_of_panicking() {
    let h = Harness::new();
    let resp = send_get(&h, &serve_once("text/plain", b"hello".to_vec()));

    let err = h.call("copy_response_body", json!({ "responseId": resp["id"] })).unwrap_err();
    assert_eq!(err, json!("The clipboard isn't available"));
}
