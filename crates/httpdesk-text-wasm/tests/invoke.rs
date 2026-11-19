//! The mock calls the core's text functions as the shell's commands: by name,
//! with the same JSON arguments, getting the same JSON back.

use httpdesk_text_wasm::invoke;
use serde_json::{json, Value};

const REQUEST: &str =
    "### List pets\n# Returns all pets.\nGET {{baseUrl}}/pets?limit=20\nAccept: application/json\n#~ X-Debug: true\n";

fn call(command: &str, args: Value) -> Value {
    serde_json::from_str(&invoke(command, &args.to_string()).unwrap()).unwrap()
}

#[test]
fn parse_request_reads_the_first_request_in_text() {
    let request = call("parse_request", json!({ "text": REQUEST }));
    assert_eq!(request["method"], "GET");
    assert_eq!(request["url"], "{{baseUrl}}/pets");
    assert_eq!(request["query"]["items"], json!([{ "enabled": true, "name": "limit", "value": "20" }]));
    assert_eq!(request["headers"]["items"][1], json!({ "enabled": false, "name": "X-Debug", "value": "true" }));
}

#[test]
fn parse_request_gives_null_for_text_with_no_request() {
    assert_eq!(call("parse_request", json!({ "text": "# just a comment\n" })), Value::Null);
}

#[test]
fn a_parsed_request_renders_back_as_written() {
    let request = call("parse_request", json!({ "text": REQUEST }));
    assert_eq!(call("render_request", json!({ "request": request })), REQUEST);
}

#[test]
fn render_request_writes_an_edited_request() {
    let mut request = call("parse_request", json!({ "text": REQUEST }));
    request["method"] = json!("DELETE");
    request["raw"] = Value::Null;
    let text = call("render_request", json!({ "request": request }));
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
fn request_text_is_a_requests_text_as_history_keeps_it() {
    let edited = "### List pets\n# Returns all pets.\nGET   {{baseUrl}}/pets?limit=20\nAccept: application/json\n";
    let request = call("parse_request", json!({ "text": edited }));
    // As written, though rendering it closes up the spaces.
    assert_ne!(call("render_request", json!({ "request": request })), edited);
    assert_eq!(call("request_text", json!({ "request": request })), edited);
}

#[test]
fn an_unknown_command_or_bad_arguments_is_an_error() {
    assert!(invoke("send_request", "{}").unwrap_err().contains("send_request"));
    assert!(invoke("render_request", "{\"request\": 1}").is_err());
}
