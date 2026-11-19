//! A request's Source view (#163): its text comes from `request_source` and what
//! the user types is read back by `parse_request`, which gives the request and the
//! problems found reading it. History's Restore request reads with it too.
//! A file view (#166) reads its whole text with `parse_file_text`, and `file_text` writes it.

use serde_json::{json, Value};

use super::history::workspace;
use super::Harness;

#[test]
fn parse_request_gives_the_request_and_its_problems() {
    let h = Harness::new();
    let parsed =
        h.ok("parse_request", json!({ "text": "### Pets\n# @nope\nGET https://example.com/pets\nAccept: */*\n" }));
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

    assert_eq!(
        h.ok("parse_request", json!({ "text": "# only a comment\n" })),
        json!({ "request": null, "problems": [] })
    );
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
    let files = [
        "examples/demo/api/pets.http",
        "examples/demo/api/chaining.http",
        "examples/demo/api/httpbin.http",
        "src/dev/jetbrains.http",
        "src/dev/pets.http",
    ];
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
    assert_eq!(
        h.ok("request_source", json!({ "request": requests[0] })),
        "### Kept\n// hand formatted\nGET   https://example.com/a\n\n"
    );

    let mut changed = requests[1].clone();
    changed["method"] = json!("DELETE");
    assert_eq!(h.ok("request_source", json!({ "request": changed })), "### Changed\nDELETE https://example.com/b\n");
}

// ---------------------------------------------------------------- the file view (#166)

#[test]
fn parse_file_text_gives_the_file_and_its_problems() {
    let h = Harness::new();
    let text = "@host = https://example.com\n\n### List\nGET {{host}}/pets\n\n### Broken\n# @nope\nGET {{host}}/a b\n";
    let parsed = h.ok("parse_file_text", json!({ "text": text }));
    assert_eq!(parsed["file"]["header"]["variables"], json!([{ "name": "host", "value": "https://example.com" }]));
    let names: Vec<&Value> = parsed["file"]["requests"].as_array().unwrap().iter().map(|r| &r["name"]).collect();
    assert_eq!(names, ["List", "Broken"]);
    let found: Vec<_> = parsed["problems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["line"].clone(), p["severity"].clone(), p["code"].clone()))
        .collect();
    assert_eq!(
        found,
        [
            (json!(7), json!("warning"), json!("unknown-directive")),
            (json!(8), json!("error"), json!("unparseable-request-line"))
        ]
    );
}

#[test]
fn every_fixture_file_round_trips_byte_for_byte_through_parse_file_text() {
    let h = Harness::new();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let files: Vec<_> = ignore::Walk::new(&root)
        .filter_map(Result::ok)
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "http"))
        .collect();
    assert!(files.len() >= 6, "found only {files:?}");
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        let parsed = h.ok("parse_file_text", json!({ "text": text }));
        assert_eq!(h.ok("file_text", json!({ "file": parsed["file"] })), text, "{}", path.display());
    }
}

/// Save as written (#164): a request whose source doesn't parse is saved as the
/// request `parse_request` recovered from it, which `save_http_file` writes as that
/// text, byte for byte, leaving the rest of the file as it was.
#[test]
fn a_request_saved_as_written_is_its_text_in_the_file() {
    let h = Harness::new();
    let text = "@host = https://example.com\n\n### List\n// hand formatted\nGET   {{host}}/books\nAccept: application/json\n\n### Create\nPOST {{host}}/books\n";
    let (_ws, root) = workspace(&h, text);
    let path = root.join("api.http");
    let mut file = h.ok("read_http_file", json!({ "path": path }));

    let source = h.ok("request_source", json!({ "request": file["requests"][0] }));
    let source = source.as_str().unwrap();
    let broken = source.replace(
        "GET   {{host}}/books\nAccept: application/json",
        "GET   {{host}}/books and more\nAccept application/json",
    );
    let parsed = h.ok("parse_request", json!({ "text": broken }));
    assert_eq!(parsed["problems"][0]["severity"], "error");
    file["requests"][0] = parsed["request"].clone();

    let saved = h.ok("save_http_file", json!({ "path": path, "file": file }));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text.replace(source, &broken));
    // Read back as the parser recovers it: the same request, its text unchanged.
    assert_eq!(h.ok("request_source", json!({ "request": saved["requests"][0] })), broken);
    assert_eq!(h.ok("read_http_file", json!({ "path": path }))["requests"].as_array().unwrap().len(), 2);
}
