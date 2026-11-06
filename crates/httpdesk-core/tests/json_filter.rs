//! JSONPath filtering of response bodies (`json_filter`).

use httpdesk_core::json_filter::{JsonDocument, Shape};

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
fn ordering_compares_decimals_and_exponents_by_value() {
    let doc = JsonDocument::parse(STORE).unwrap();
    let result = doc.filter("$.items[?@.price > 10].id").unwrap();
    assert_eq!(result.text, "[\n  1234567890123456789,\n  2\n]");
}

/// The ids of the items a filter predicate keeps, as written in the body.
fn ids(body: &str, predicate: &str) -> String {
    let doc = JsonDocument::parse(body).unwrap();
    let text = doc.filter(&format!("$.items[?{predicate}].id")).unwrap().text;
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

const BIG_IDS: &str = r#"{"items": [
  {"id": 1234567890123456788},
  {"id": 1234567890123456789},
  {"id": 9007199254740992},
  {"id": 9007199254740993},
  {"id": -9007199254740993}
]}"#;

#[test]
fn equality_on_nineteen_digit_ids_is_exact() {
    assert_eq!(ids(BIG_IDS, "@.id==1234567890123456789"), "[ 1234567890123456789 ]");
    assert_eq!(
        ids(BIG_IDS, "@.id!=1234567890123456789"),
        "[ 1234567890123456788, 9007199254740992, 9007199254740993, -9007199254740993 ]"
    );
}

#[test]
fn equality_just_past_two_to_the_53_is_exact() {
    assert_eq!(ids(BIG_IDS, "@.id==9007199254740993"), "[ 9007199254740993 ]");
    assert_eq!(ids(BIG_IDS, "@.id==9007199254740992"), "[ 9007199254740992 ]");
    assert_eq!(ids(BIG_IDS, "@.id==-9007199254740993"), "[ -9007199254740993 ]");
}

#[test]
fn ordering_just_past_two_to_the_53_is_exact() {
    assert_eq!(ids(BIG_IDS, "@.id>9007199254740992"), "[ 1234567890123456788, 1234567890123456789, 9007199254740993 ]");
    assert_eq!(ids(BIG_IDS, "@.id<9007199254740993"), "[ 9007199254740992, -9007199254740993 ]");
    assert_eq!(
        ids(BIG_IDS, "@.id>=9007199254740993"),
        "[ 1234567890123456788, 1234567890123456789, 9007199254740993 ]"
    );
    assert_eq!(ids(BIG_IDS, "@.id<=-9007199254740993"), "[ -9007199254740993 ]");
}

#[test]
fn ordering_on_nineteen_digit_ids_is_exact() {
    assert_eq!(ids(BIG_IDS, "@.id>1234567890123456788"), "[ 1234567890123456789 ]");
    assert_eq!(ids(BIG_IDS, "@.id<1234567890123456789 && @.id>9007199254740993"), "[ 1234567890123456788 ]");
}

#[test]
fn integers_compare_exactly_with_decimals_and_exponents() {
    let body = r#"{"items": [{"id": 1, "n": 1e3}, {"id": 2, "n": 1000}, {"id": 3, "n": 10.50}, {"id": 4, "n": 9007199254740993}]}"#;
    assert_eq!(ids(body, "@.n==1000"), "[ 1, 2 ]");
    assert_eq!(ids(body, "@.n==1e3"), "[ 1, 2 ]");
    assert_eq!(ids(body, "@.n==10.5"), "[ 3 ]");
    // 9007199254740992.0 is a float; the integer one above it is not equal to it, and is greater.
    assert_eq!(ids(body, "@.n==9007199254740992.0"), "[]");
    assert_eq!(ids(body, "@.n>9007199254740992.0"), "[ 4 ]");
    assert_eq!(ids(body, "@.n>10.4 && @.n<10.6"), "[ 3 ]");
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

// ------------------------------------------------------------ shape summary

/// `(key, child)` pairs of a shape, by name only, for compact assertions.
fn key_names(shape: &Shape) -> Vec<&str> {
    shape.keys.iter().map(|(k, _)| k.as_str()).collect()
}

fn child<'a>(shape: &'a Shape, key: &str) -> &'a Shape {
    &shape.keys.iter().find(|(k, _)| k == key).unwrap_or_else(|| panic!("no key {key}")).1
}

#[test]
fn the_shape_lists_the_keys_reachable_at_each_place_merged_across_array_items() {
    let doc = JsonDocument::parse(
        r#"{"items": [{"id": 1, "name": "Rex"}, {"id": 2, "owner": {"name": "Ann"}}, 3], "total": 2, "odd key": []}"#,
    )
    .unwrap();
    let shape = doc.shape();
    assert_eq!(key_names(shape), ["items", "total", "odd key"]);
    assert_eq!(shape.items, None);
    let items = child(shape, "items").items.as_deref().expect("items is an array");
    assert_eq!(key_names(items), ["id", "name", "owner"]);
    assert_eq!(key_names(child(items, "owner")), ["name"]);
    assert_eq!(child(shape, "total"), &Shape::default());
    // An empty array is still an array; its items just have no keys.
    assert_eq!(child(shape, "odd key").items.as_deref(), Some(&Shape::default()));
}

#[test]
fn the_shape_is_computed_once_per_document() {
    let doc = JsonDocument::parse(STORE).unwrap();
    assert!(std::ptr::eq(doc.shape(), doc.shape()));
}

#[test]
fn the_shape_keeps_at_most_a_thousand_keys_per_object() {
    let body = format!("{{{}}}", (0..1500).map(|i| format!("\"k{i}\": {i}")).collect::<Vec<_>>().join(","));
    let doc = JsonDocument::parse(&body).unwrap();
    assert_eq!(doc.shape().keys.len(), 1000);
    assert_eq!(doc.shape().keys[999].0, "k999");
}

#[test]
fn the_shape_serialises_keys_as_pairs_in_document_order() {
    let doc = JsonDocument::parse(r#"{"b": [{"x": 1}], "a": {}, "1": 0}"#).unwrap();
    assert_eq!(
        serde_json::to_value(doc.shape()).unwrap(),
        serde_json::json!({ "keys": [["b", { "items": { "keys": [["x", {}]] } }], ["a", {}], ["1", {}]] })
    );
}

#[test]
fn a_body_nested_deeper_than_the_parser_allows_says_so() {
    // serde_json stops at 128 levels; the formatter allows far more.
    let deep = format!("{}1{}", "[".repeat(200), "]".repeat(200));
    let err = JsonDocument::parse(&deep).unwrap_err().to_string();
    assert_eq!(err, "This body is nested too deeply to filter");
}

#[test]
fn a_body_just_inside_the_parsers_depth_limit_still_filters() {
    let deep = format!("{}1{}", "[".repeat(127), "]".repeat(127));
    let doc = JsonDocument::parse(&deep).unwrap();
    assert_eq!(doc.filter("$..*").unwrap().matches, 127);
}
