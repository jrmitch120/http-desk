//! `response_body`: the viewer fetches a response's body by id and view (raw
//! text, Pretty text or bytes) as a raw IPC response, which the webview gets
//! as an `ArrayBuffer` rather than a JSON string.

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, INVOKE_KEY};
use tauri::webview::InvokeRequest;

use super::{send_get, serve_once, Harness, APP_URL};

/// Fetches `view` of the body of `response_id`: its raw bytes, or the error.
pub(super) fn fetch(h: &Harness, response_id: &Value, view: &str) -> Result<Vec<u8>, Value> {
    let body = get_ipc_response(
        &h.webview,
        InvokeRequest {
            cmd: "response_body".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: APP_URL.parse().unwrap(),
            body: InvokeBody::Json(json!({ "responseId": response_id, "view": view })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )?;
    match body {
        InvokeResponseBody::Raw(bytes) => Ok(bytes),
        InvokeResponseBody::Json(json) => panic!("expected raw bytes, got JSON {json}"),
    }
}

#[test]
fn raw_text_arrives_as_utf8_decoded_from_the_declared_charset() {
    let h = Harness::new();
    let url = serve_once("text/plain; charset=iso-8859-1", vec![b'c', b'a', b'f', 0xE9]);
    let resp = send_get(&h, &url);
    assert_eq!(fetch(&h, &resp["id"], "raw").unwrap(), "café".as_bytes());
}

#[test]
fn pretty_text_keeps_a_19_digit_id_as_the_server_sent_it() {
    let h = Harness::new();
    let url = serve_once("application/json", br#"{"id":1234567890123456789,"price":10.50}"#.to_vec());
    let resp = send_get(&h, &url);
    let pretty = fetch(&h, &resp["id"], "pretty").unwrap();
    assert_eq!(String::from_utf8(pretty).unwrap(), "{\n  \"id\": 1234567890123456789,\n  \"price\": 10.50\n}");
}

#[test]
fn bytes_are_a_binary_body_exactly_as_received() {
    let h = Harness::new();
    let png: Vec<u8> = b"\x89PNG\r\n\x1a\n".iter().copied().chain(0..=255).collect();
    let resp = send_get(&h, &serve_once("image/png", png.clone()));
    assert_eq!(fetch(&h, &resp["id"], "bytes").unwrap(), png);
}

#[test]
fn an_unknown_id_is_no_longer_available_in_every_view() {
    let h = Harness::new();
    for view in ["raw", "pretty", "bytes"] {
        assert_eq!(fetch(&h, &json!("gone"), view).unwrap_err(), json!("Response is no longer available"));
    }
}

#[test]
fn pretty_text_is_refused_for_a_body_that_isnt_json_or_xml_or_doesnt_parse() {
    let h = Harness::new();
    let text = send_get(&h, &serve_once("text/plain", b"hello".to_vec()));
    assert_eq!(fetch(&h, &text["id"], "pretty").unwrap_err(), json!("Response body isn't JSON or XML"));

    for (content_type, body) in [("application/json", r#"{"id": 1, oops}"#), ("application/xml", "<a><b></a>")] {
        let bad = send_get(&h, &serve_once(content_type, body.as_bytes().to_vec()));
        assert_eq!(
            fetch(&h, &bad["id"], "pretty").unwrap_err(),
            json!("Response body isn't JSON or XML"),
            "{content_type}"
        );
        assert_eq!(fetch(&h, &bad["id"], "raw").unwrap(), body.as_bytes(), "{content_type}");
    }
}
