//! How long the shell keeps a response's body: until the webview releases it
//! (`release_response`) or the page loads again, however many others are sent.

use serde_json::{json, Value};
use tauri::Manager;

use super::fetch::fetch;
use super::{send_get, serve_once, Harness};

const GONE: &str = "Response is no longer available";

/// Sends a JSON response whose `n` is `n`; returns its response id.
fn send_json(h: &Harness, n: usize) -> Value {
    let url = serve_once("application/json", format!(r#"{{"n":{n},"id":1234567890123456789}}"#).into_bytes());
    send_get(h, &url)["id"].clone()
}

#[test]
fn the_first_of_25_responses_can_still_be_saved_filtered_and_opened_in_pretty() {
    let h = Harness::new();
    let ids: Vec<Value> = (0..25).map(|n| send_json(&h, n)).collect();
    let first = &ids[0];

    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("first.json");
    h.ok("save_response_body", json!({ "responseId": first, "path": path }));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"n":0,"id":1234567890123456789}"#);

    let filtered = h.ok("filter_response", json!({ "responseId": first, "expression": "$.n" }));
    assert_eq!(filtered["text"], "[\n  0\n]");

    let pretty = fetch(&h, first, "pretty").unwrap();
    assert_eq!(String::from_utf8(pretty).unwrap(), "{\n  \"n\": 0,\n  \"id\": 1234567890123456789\n}");
}

/// What Save, Hex, the filter, key completion and fetching the body as raw
/// text, Pretty text or bytes report for response `id`, `None` where they succeed.
fn uses(h: &Harness, id: &Value) -> [Option<Value>; 7] {
    let out = tempfile::tempdir().unwrap();
    [
        h.call("save_response_body", json!({ "responseId": id, "path": out.path().join("body") })).err(),
        h.call("hexdump", json!({ "responseId": id })).err(),
        h.call("filter_response", json!({ "responseId": id, "expression": "$.n" })).err(),
        h.call("response_shape", json!({ "responseId": id })).err(),
        fetch(h, id, "raw").err(),
        fetch(h, id, "pretty").err(),
        fetch(h, id, "bytes").err(),
    ]
}

const ALL_OK: [Option<Value>; 7] = [None, None, None, None, None, None, None];

fn all_gone() -> [Option<Value>; 7] {
    std::array::from_fn(|_| Some(json!(GONE)))
}

#[test]
fn a_released_response_is_no_longer_available_nor_is_its_parsed_json() {
    let h = Harness::new();
    let released = send_json(&h, 1);
    let kept = send_json(&h, 2);
    // Parses and caches it for the filter and key completion.
    assert_eq!(uses(&h, &released), ALL_OK);

    h.ok("release_response", json!({ "responseId": released }));

    assert_eq!(uses(&h, &released), all_gone());
    assert_eq!(uses(&h, &kept), ALL_OK);
    // Releasing it again, or an id never kept, is harmless.
    h.ok("release_response", json!({ "responseId": released }));
    h.ok("release_response", json!({ "responseId": "never-sent" }));
}

/// The mock runtime never loads a page (and a page-load payload can't be built in
/// a test), so this calls what the `on_page_load` hook runs when a load starts.
#[test]
fn a_page_load_drops_every_kept_body_and_its_parsed_json() {
    let h = Harness::new();
    let ids = [send_json(&h, 1), send_json(&h, 2)];
    for id in &ids {
        assert_eq!(uses(&h, id), ALL_OK);
    }

    crate::page_loaded(&h.app.state::<crate::AppState>());

    for id in &ids {
        assert_eq!(uses(&h, id), all_gone());
    }
}
