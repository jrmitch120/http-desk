//! The mock calls the core's text functions as the shell's commands: by name,
//! with the same JSON arguments, getting the same JSON back.

use httpdesk_text_wasm::invoke;
use serde_json::{json, Value};

const REQUEST: &str =
    "### List pets\n# Returns all pets.\nGET {{baseUrl}}/pets?limit=20\nAccept: application/json\n#~ X-Debug: true\n";

fn call(command: &str, args: Value) -> Value {
    serde_json::from_str(&invoke(command, &args.to_string()).unwrap()).unwrap()
}

/// The request `parse_request` reads in `text`.
fn parse(text: &str) -> Value {
    call("parse_request", json!({ "text": text }))["request"].clone()
}

#[test]
fn parse_request_reads_the_first_request_in_text() {
    let request = parse(REQUEST);
    assert_eq!(request["method"], "GET");
    assert_eq!(request["url"], "{{baseUrl}}/pets");
    assert_eq!(request["query"]["items"], json!([{ "enabled": true, "name": "limit", "value": "20" }]));
    assert_eq!(request["headers"]["items"][1], json!({ "enabled": false, "name": "X-Debug", "value": "true" }));
}

#[test]
fn parse_request_gives_no_request_for_text_with_none() {
    assert_eq!(
        call("parse_request", json!({ "text": "# just a comment\n" })),
        json!({ "request": null, "problems": [] })
    );
}

#[test]
fn parse_request_gives_the_problems_found_reading_the_text() {
    let parsed = call("parse_request", json!({ "text": "GET https://example.com/a b\n" }));
    assert_eq!(parsed["request"]["method"], "GET");
    assert_eq!(parsed["problems"][0]["code"], "unparseable-request-line");
    assert_eq!((&parsed["problems"][0]["line"], &parsed["problems"][0]["severity"]), (&json!(1), &json!("error")));
}

#[test]
fn a_parsed_requests_source_is_its_text_as_written() {
    let edited = format!("// a comment block before it\n\n{}", REQUEST.replace("GET ", "GET   "));
    assert_eq!(call("request_source", json!({ "request": parse(&edited) })), edited);
}

#[test]
fn request_source_writes_an_edited_request() {
    let mut request = parse(REQUEST);
    request["method"] = json!("DELETE");
    let text = call("request_source", json!({ "request": request }));
    assert!(text.as_str().unwrap().contains("DELETE {{baseUrl}}/pets?limit=20\n"), "{text}");
}

#[test]
fn parse_file_reads_a_whole_file() {
    let file = call(
        "parse_file",
        json!({ "text": format!("@petId = 1\n\n{REQUEST}\n### Get pet\nGET /pets/{{{{petId}}}}\n") }),
    );
    assert_eq!(file["header"]["variables"], json!([{ "name": "petId", "value": "1" }]));
    let names: Vec<&Value> = file["requests"].as_array().unwrap().iter().map(|r| &r["name"]).collect();
    assert_eq!(names, ["List pets", "Get pet"]);
}

#[test]
fn file_text_writes_a_file_as_the_shell_saves_it() {
    let text = format!("@petId = 1\n\n{REQUEST}\n### Get pet\nGET /pets/{{{{petId}}}}\n");
    let mut file = call("parse_file", json!({ "text": text }));
    assert_eq!(call("file_text", json!({ "file": file })), text);

    // Saved as written (#164): a request recovered from text that doesn't parse is that text.
    let source = call("request_source", json!({ "request": file["requests"][0] }));
    let broken = source.as_str().unwrap().replace("/pets?limit=20", "/pets and more");
    file["requests"][0] = parse(&broken);
    assert_eq!(call("file_text", json!({ "file": file })), text.replace("/pets?limit=20", "/pets and more"));
}

#[test]
fn request_text_is_a_requests_text_as_history_keeps_it() {
    let edited = "### List pets\n# Returns all pets.\nGET   {{baseUrl}}/pets?limit=20\nAccept: application/json\n";
    let request = parse(edited);
    assert_eq!(call("request_text", json!({ "request": request })), edited);
}

#[test]
fn request_problems_reads_a_requests_source_as_the_shell_does() {
    let file = call("parse_file", json!({ "text": "### Broken\n# @nmae x\nPOST https://a b\n\n< ./payload.json\n" }));
    let read = call("request_problems", json!({ "request": file["requests"][0] }));
    let at = |p: &Value| (p["line"].clone(), p["column"].clone(), p["code"].clone());
    let problems: Vec<_> = read["problems"].as_array().unwrap().iter().map(at).collect();
    assert_eq!(
        problems,
        [(json!(2), json!(3), json!("unknown-directive")), (json!(3), json!(1), json!("unparseable-request-line"))]
    );
    assert_eq!(read["files"][0]["path"], "./payload.json");
    assert_eq!(at(&read["files"][0]["missing"]), (json!(5), json!(1), json!("missing-file")));
}

#[test]
fn request_portability_marks_the_lines_of_the_source() {
    let request = parse(&format!("# Pets\n\n{REQUEST}"));
    let marks = call("request_portability", json!({ "request": request }));
    assert_eq!(
        marks,
        json!([{
            "line": 7,
            "construct": "disabled-line",
            "support": "httpdesk-only",
            "label": "#~",
            "hover": "Turned off in HttpDesk: VS Code and Rider both ignore this line",
        }])
    );
}

#[test]
fn portability_text_marks_the_lines_of_text_that_isnt_a_request_yet() {
    let marks = call("portability_text", json!({ "text": "### Draft\n# @no-log\nGET\n#~ X-Debug: true\n" }));
    let found: Vec<_> = marks.as_array().unwrap().iter().map(|m| (m["line"].clone(), m["construct"].clone())).collect();
    assert_eq!(found, [(json!(2), json!("no-log-directive")), (json!(4), json!("disabled-line"))]);
}

#[test]
fn parse_file_text_gives_the_file_and_the_problems_found_reading_it() {
    let parsed =
        call("parse_file_text", json!({ "text": format!("@petId = 1\n\n{REQUEST}\n### Broken\nGET /pets/a b\n") }));
    assert_eq!(parsed["file"]["header"]["variables"], json!([{ "name": "petId", "value": "1" }]));
    let names: Vec<&Value> = parsed["file"]["requests"].as_array().unwrap().iter().map(|r| &r["name"]).collect();
    assert_eq!(names, ["List pets", "Broken"]);
    let found: Vec<_> =
        parsed["problems"].as_array().unwrap().iter().map(|p| (p["line"].clone(), p["code"].clone())).collect();
    assert_eq!(found, [(json!(10), json!("unparseable-request-line"))]);
}

/// Every `.http` file in the repository (git-ignored paths such as `target/` skipped).
fn fixture_files() -> Vec<std::path::PathBuf> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let files: Vec<_> = ignore::Walk::new(&root)
        .filter_map(Result::ok)
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "http"))
        .collect();
    assert!(files.len() >= 6, "found only {files:?}");
    files
}

#[test]
fn every_fixture_file_round_trips_byte_for_byte_through_parse_file_text() {
    for path in fixture_files() {
        let text = std::fs::read_to_string(&path).unwrap();
        let parsed = call("parse_file_text", json!({ "text": text }));
        assert_eq!(call("file_text", json!({ "file": parsed["file"] })), text, "{}", path.display());
    }
}

#[test]
fn an_unknown_command_or_bad_arguments_is_an_error() {
    assert!(invoke("send_request", "{}").unwrap_err().contains("send_request"));
    assert!(invoke("request_source", "{\"request\": 1}").is_err());
}
