//! JSONPath filtering of response bodies (`json_filter`).

use httpdesk_core::json_filter::JsonDocument;

const STORE: &str = r#"{
  "items": [
    {"id": 1234567890123456789, "status": "sold", "price": 10.50},
    {"id": 2, "status": "available", "price": 1e3},
    {"id": 9007199254740993, "status": "sold", "price": -0}
  ]
}"#;

#[test]
fn a_filter_selects_exactly_the_matching_values() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let result = doc.filter(r#"$.items[?(@.status=="sold")].id"#).unwrap();
    assert_eq!(result.matches, 2);
    assert_eq!(result.text, "[\n  1234567890123456789,\n  9007199254740993\n]");
}

#[test]
fn matched_numbers_keep_the_text_the_server_sent() {
    let doc = JsonDocument::parse(r#"{"a": [10.50, 1e3, -0, 123456789012345678901234567890, 1.0E-7]}"#).unwrap();
    let result = doc.filter("$.a[*]").unwrap();
    assert_eq!(result.matches, 5);
    assert_eq!(result.text, "[\n  10.50,\n  1e3,\n  -0,\n  123456789012345678901234567890,\n  1.0E-7\n]");
}

#[test]
fn whole_objects_are_pretty_printed_in_document_order() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let result = doc.filter("$.items[1]").unwrap();
    assert_eq!(result.matches, 1);
    assert_eq!(result.text, "[\n  {\n    \"id\": 2,\n    \"status\": \"available\",\n    \"price\": 1e3\n  }\n]");
}

#[test]
fn numeric_comparisons_work_on_exact_numbers() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let result = doc.filter("$.items[?@.price > 10].id").unwrap();
    assert_eq!(result.text, "[\n  1234567890123456789,\n  2\n]");
}

#[test]
fn no_matches_is_an_empty_array() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let result = doc.filter("$.nothing").unwrap();
    assert_eq!((result.matches, result.text.as_str()), (0, "[]"));
}

#[test]
fn an_invalid_expression_is_an_error_naming_the_position() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let err = doc.filter("$.items[?(@.status==").unwrap_err().to_string();
    assert!(err.starts_with("Invalid JSONPath at position "), "{err}");
    let err = doc.filter("items").unwrap_err().to_string();
    assert!(err.starts_with("Invalid JSONPath"), "{err}");
}

#[test]
fn a_body_that_isnt_json_is_an_error() {
    let err = JsonDocument::parse(r#"{"id": 1, oops}"#).unwrap_err().to_string();
    assert!(err.starts_with("The body isn't valid JSON: "), "{err}");
}

#[test]
fn a_byte_order_mark_is_ignored() {
    let doc = JsonDocument::parse("\u{feff}{\"a\": 1}").unwrap();
    assert_eq!(doc.filter("$.a").unwrap().text, "[\n  1\n]");
}

#[test]
fn matched_strings_keep_their_escapes() {
    let doc = JsonDocument::parse(r#"{"s": ["caf\u00e9", "a\/b", "say \"hi\""]}"#).unwrap();
    assert_eq!(doc.filter("$.s[*]").unwrap().text, "[\n  \"caf\\u00e9\",\n  \"a\\/b\",\n  \"say \\\"hi\\\"\"\n]");
}

#[test]
fn keys_written_with_escapes_are_found() {
    let doc = JsonDocument::parse(r#"{"odd \"key\"": {"caf\u00e9": 1e3}, "other": 2}"#).unwrap();
    assert_eq!(doc.filter(r#"$['odd "key"']['café']"#).unwrap().text, "[\n  1e3\n]");
}

#[test]
fn a_repeated_key_matches_its_last_value() {
    let doc = JsonDocument::parse(r#"{"a": 1.0, "b": 2, "a": 3.00}"#).unwrap();
    assert_eq!(doc.filter("$.a").unwrap().text, "[\n  3.00\n]");
}

#[test]
fn descendants_are_found_and_nested_matches_are_indented() {
    let doc = JsonDocument::parse(r#"{"x": {"id": 10.0, "y": [{"id": {"deep": [1e3]}}]}}"#).unwrap();
    let result = doc.filter("$..id").unwrap();
    assert_eq!(result.matches, 2);
    assert_eq!(result.text, "[\n  10.0,\n  {\n    \"deep\": [\n      1e3\n    ]\n  }\n]");
}

#[test]
fn the_root_matches_the_whole_body() {
    let doc = JsonDocument::parse(" [1.50, {}] ").unwrap();
    assert_eq!(doc.filter("$").unwrap().text, "[\n  [\n    1.50,\n    {}\n  ]\n]");
}

#[test]
fn the_same_node_selected_twice_is_listed_twice() {
    let doc = JsonDocument::parse("[7.0, 8]").unwrap();
    let result = doc.filter("$[0, 0]").unwrap();
    assert_eq!((result.matches, result.text.as_str()), (2, "[\n  7.0,\n  7.0\n]"));
}
