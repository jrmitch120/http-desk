//! The send reply carries metadata only, never a body (ADR 0006): the viewer
//! fetches every body by response id. A body kept as received, because its
//! Content-Encoding couldn't be undone, is binary in every view.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Manager;

use super::fetch::fetch;
use super::{send_get, serve_once, Harness};

/// Fields the send reply used to carry a body in.
const BODY_FIELDS: [&str; 3] = ["bodyText", "bodyBase64", "prettyText"];

fn assert_no_body(reply: &Value) {
    let fields = reply.as_object().unwrap();
    for field in BODY_FIELDS {
        assert!(!fields.contains_key(field), "the reply has {field}: {reply}");
    }
}

#[test]
fn the_reply_to_a_send_carries_no_body_for_text_or_binary() {
    let h = Harness::new();
    let json = send_get(&h, &serve_once("application/json", br#"{"id":1}"#.to_vec()));
    assert_eq!((&json["status"], &json["bodyKind"], &json["bodySize"]), (&json!(200), &json!("json"), &json!(8)));
    assert_no_body(&json);

    let png = send_get(&h, &serve_once("image/png", b"\x89PNG\r\n\x1a\n\x00\xff".to_vec()));
    assert_eq!((&png["bodyKind"], &png["bodySize"]), (&json!("image"), &json!(10)));
    assert_no_body(&png);
}

/// Serves one JSON response whose body claims `Content-Encoding: compress`,
/// which isn't decoded, so it's kept as received; returns the URL.
fn serve_still_compressed(body: &'static [u8]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: compress\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body));
    });
    url
}

/// Still-compressed bytes that happen to be valid UTF-8 JSON-looking text, so
/// only the kind says they aren't text.
const STILL_COMPRESSED: &[u8] = br#"{"not":"really json"}"#;

#[test]
fn a_body_kept_as_received_is_binary_whatever_its_content_type_says() {
    let h = Harness::new();
    let resp = send_get(&h, &serve_still_compressed(STILL_COMPRESSED));
    assert_eq!(resp["bodyKind"], "binary");
    assert_no_body(&resp);

    assert_eq!(fetch(&h, &resp["id"], "bytes").unwrap(), STILL_COMPRESSED);
    for view in ["raw", "pretty"] {
        assert_eq!(fetch(&h, &resp["id"], view).unwrap_err(), json!("Response body isn't text"), "{view}");
    }
    let err = h.call("filter_response", json!({ "responseId": resp["id"], "expression": "$.not" })).unwrap_err();
    assert_eq!(err, json!("The body isn't text"));
    let dump = h.ok("hexdump", json!({ "responseId": resp["id"] }));
    assert!(dump.as_str().unwrap().starts_with("00000000  7b 22 6e 6f 74"), "{dump}");
}

#[test]
fn a_body_kept_as_received_is_copied_as_base64() {
    let h = Harness::new();
    let writes = Arc::new(Mutex::new(Vec::new()));
    let w = writes.clone();
    h.app.state::<crate::AppState>().clipboard.replace(move |text| {
        w.lock().unwrap().push(text);
        Ok(())
    });
    let resp = send_get(&h, &serve_still_compressed(STILL_COMPRESSED));

    h.ok("copy_response_body", json!({ "responseId": resp["id"] }));
    assert_eq!(*writes.lock().unwrap(), ["eyJub3QiOiJyZWFsbHkganNvbiJ9"]);
}
