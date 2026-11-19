//! A request's Source view (#163): its text comes from `request_source` and what
//! the user types is read back by `parse_request`, which gives the request and the
//! problems found reading it. History's Restore request reads with it too.

use serde_json::{json, Value};

use super::history::workspace;
use super::Harness;

#[test]
fn parse_request_gives_the_request_and_its_problems() {
    let h = Harness::new();
    let parsed = h.ok("parse_request", json!({ "text": "### Pets\n# @nope\nGET https://example.com/pets\nAccept: */*\n" }));
    assert_eq!(parsed["request"]["url"], "https://example.com/pets");
    assert_eq!(parsed["request"]["headers"]["items"][0]["name"], "Accept");
    assert_eq!(
        parsed["problems"],
        json!([{ "line": 2, "column": 3, "severity": "warning", "code": "unknown-directive",
                 "message": parsed["problems"][0]["message"] }])
    );

    let broken = h.ok("parse_request", json!({ "text": "GET https://example.com/a b\n" }));
    assert_eq!(broken["problems"][0]["code"], "unparseable-request-line");
    assert_eq!(broken["problems"][0]["severity"], "error");

    assert_eq!(h.ok("parse_request", json!({ "text": "# only a comment\n" })), json!({ "request": null, "problems": [] }));
}

/// Every request of every `.http` file in `text`, as the webview has them.
fn requests_of(h: &Harness, text: &str) -> Vec<Value> {
    let (_ws, root) = workspace(h, text);
    h.ok("read_http_file", json!({ "path": root.join("api.http") }))["requests"].as_array().unwrap().clone()
}

#[test]
fn a_requests_source_parses_back_to_the_same_request() {
    let h = Harness::new();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let files = ["examples/demo/api/pets.http", "examples/demo/api/chaining.http", "examples/demo/api/httpbin.http", "src/dev/jetbrains.http", "src/dev/pets.http"];
    for file in files {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        for request in requests_of(&h, &text) {
            let source = h.ok("request_source", json!({ "request": request }));
            let parsed = h.ok("parse_request", json!({ "text": source }));
            assert_eq!(parsed["request"], request, "{file}: {source}");
        }
    }
}

#[test]
fn a_requests_source_is_its_text_as_written_until_it_changes() {
    let h = Harness::new();
    let text = "### Kept\n// hand formatted\nGET   https://example.com/a\n\n### Changed\nGET https://example.com/b\n";
    let requests = requests_of(&h, text);
    assert_eq!(h.ok("request_source", json!({ "request": requests[0] })), "### Kept\n// hand formatted\nGET   https://example.com/a\n\n");

    let mut changed = requests[1].clone();
    changed["method"] = json!("DELETE");
    assert_eq!(h.ok("request_source", json!({ "request": changed })), "### Changed\nDELETE https://example.com/b\n");
}
