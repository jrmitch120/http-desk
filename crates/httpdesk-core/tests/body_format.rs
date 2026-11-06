//! Lossless body formatting: only whitespace between tokens changes; every
//! number and string token is copied byte for byte.

use httpdesk_core::body_format::{format_json, FormatMode};
use proptest::prelude::*;

fn pretty(text: &str) -> String {
    format_json(text, FormatMode::Pretty).expect("valid JSON")
}

#[test]
fn pretty_keeps_every_number_and_string_token_as_written() {
    let input = r#"{"id": 9007199254740993, "price": 10.50, "e": 1e3, "z": -0, "s": "é"}"#;
    assert_eq!(
        pretty(input),
        "{\n  \"id\": 9007199254740993,\n  \"price\": 10.50,\n  \"e\": 1e3,\n  \"z\": -0,\n  \"s\": \"é\"\n}"
    );
}

#[test]
fn duplicate_keys_and_key_order_are_kept() {
    assert_eq!(pretty(r#"{"b":1,"a":2,"b":3}"#), "{\n  \"b\": 1,\n  \"a\": 2,\n  \"b\": 3\n}");
}

#[test]
fn escapes_in_strings_are_copied_not_decoded() {
    assert_eq!(pretty(r#"["\u00e9\n\"\/", "\uD83D\uDE00"]"#), "[\n  \"\\u00e9\\n\\\"\\/\",\n  \"\\uD83D\\uDE00\"\n]");
}

#[test]
fn empty_objects_and_arrays_format_as_a_pair_of_brackets() {
    assert_eq!(pretty("{ \"a\": { }, \"b\": [\n] }"), "{\n  \"a\": {},\n  \"b\": []\n}");
    assert_eq!(pretty(" [ ] "), "[]");
}

#[test]
fn nested_containers_indent_two_spaces_per_level() {
    assert_eq!(
        pretty(r#"{"items":[{"id":1,"tags":["a"]},true,null]}"#),
        "{\n  \"items\": [\n    {\n      \"id\": 1,\n      \"tags\": [\n        \"a\"\n      ]\n    },\n    true,\n    null\n  ]\n}"
    );
}

#[test]
fn a_scalar_at_the_top_level_formats_as_itself() {
    assert_eq!(pretty("  1.0E+2 \n"), "1.0E+2");
    assert_eq!(pretty("\"x\""), "\"x\"");
}

#[test]
fn minify_removes_every_whitespace_outside_strings() {
    let input = "{\n  \"a b\": [ 1 , 2.50 ],\n\t\"c\" : { \"d\" : \" x \" }\r\n}";
    assert_eq!(format_json(input, FormatMode::Minify).unwrap(), r#"{"a b":[1,2.50],"c":{"d":" x "}}"#);
}

#[test]
fn minify_keeps_numbers_byte_for_byte_and_beautify_after_minify_restores_the_pretty_form() {
    let pretty_form =
        "{\n  \"id\": 9007199254740993,\n  \"price\": 10.50,\n  \"e\": 1e3,\n  \"tags\": [\n    \"a b\"\n  ]\n}";
    let minified = format_json(pretty_form, FormatMode::Minify).unwrap();
    assert_eq!(minified, r#"{"id":9007199254740993,"price":10.50,"e":1e3,"tags":["a b"]}"#);
    assert_eq!(pretty(&minified), pretty_form);
}

#[test]
fn invalid_json_is_an_error_naming_where() {
    for bad in [
        "",
        "{",
        "[1,]",
        "{\"a\":1,}",
        "{a:1}",
        "{\"a\" 1}",
        "[1 2]",
        "01",
        "1.",
        "1e",
        "-",
        ".5",
        "+1",
        "tru",
        "truex",
        "nul",
        "\"abc",
        "\"a\\x\"",
        "\"\\u12G4\"",
        "\"tab\there\"",
        "[1]]",
        "{} {}",
        "{\"id\": {{id}}}",
        "NaN",
    ] {
        assert!(format_json(bad, FormatMode::Pretty).is_err(), "{bad:?} should be rejected");
        assert!(format_json(bad, FormatMode::Minify).is_err(), "{bad:?} should be rejected");
    }
    let err = format_json("{\n  \"a\": 1,\n  oops\n}", FormatMode::Pretty).unwrap_err();
    assert_eq!(err.to_string(), "Invalid JSON at line 3, column 3: expected a quoted key");
}

#[test]
fn ten_thousand_levels_of_nesting_return_an_error_instead_of_overflowing() {
    let deep = format!("{}{}", "[".repeat(10_000), "]".repeat(10_000));
    let err = format_json(&deep, FormatMode::Pretty).unwrap_err();
    assert!(err.to_string().contains("nested"), "{err}");
}

/// A generated JSON document: leaves are tokens as they'd be written.
#[derive(Debug, Clone)]
enum Json {
    Leaf(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

const NUMBER: &str = r"-?(0|[1-9][0-9]{0,24})(\.[0-9]{1,4})?([eE][+-]?[0-9]{1,3})?";
const STRING: &str = r#""([a-zA-Z0-9 é{}\[\]:,]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*""#;

fn json() -> impl Strategy<Value = Json> {
    let leaf = prop_oneof![
        NUMBER.prop_map(Json::Leaf),
        STRING.prop_map(Json::Leaf),
        Just(Json::Leaf("true".into())),
        Just(Json::Leaf("false".into())),
        Just(Json::Leaf("null".into())),
    ];
    leaf.prop_recursive(6, 64, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Json::Array),
            prop::collection::vec((STRING, inner), 0..6).prop_map(Json::Object),
        ]
    })
}

/// Writes `doc` with the gaps between tokens filled from `gaps` (cycled), so
/// `render(doc, &[""])` is the document with no whitespace at all.
fn render(doc: &Json, gaps: &[String]) -> String {
    fn gap(gaps: &[String], n: &mut usize, out: &mut String) {
        out.push_str(&gaps[*n % gaps.len()]);
        *n += 1;
    }
    fn go(doc: &Json, gaps: &[String], n: &mut usize, out: &mut String) {
        match doc {
            Json::Leaf(token) => out.push_str(token),
            Json::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    gap(gaps, n, out);
                    go(item, gaps, n, out);
                    gap(gaps, n, out);
                }
                out.push(']');
            }
            Json::Object(members) => {
                out.push('{');
                for (i, (key, value)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    gap(gaps, n, out);
                    out.push_str(key);
                    gap(gaps, n, out);
                    out.push(':');
                    gap(gaps, n, out);
                    go(value, gaps, n, out);
                    gap(gaps, n, out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::new();
    let mut n = 0;
    go(doc, gaps, &mut n, &mut out);
    out
}

proptest! {
    #[test]
    fn minify_strips_only_insignificant_whitespace_and_undoes_pretty(
        doc in json(),
        gaps in prop::collection::vec("[ \t\n\r]{0,3}", 1..20),
    ) {
        let spaced = format!("{}{}{}", gaps[0], render(&doc, &gaps), gaps[gaps.len() - 1]);
        let compact = render(&doc, &[String::new()]);
        let minified = format_json(&spaced, FormatMode::Minify).unwrap();
        prop_assert_eq!(&minified, &compact);
        let pretty = format_json(&spaced, FormatMode::Pretty).unwrap();
        prop_assert_eq!(format_json(&pretty, FormatMode::Minify).unwrap(), minified);
    }
}

#[test]
fn nesting_up_to_the_limit_formats() {
    let depth = httpdesk_core::body_format::MAX_DEPTH;
    let deep = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
    assert_eq!(format_json(&deep, FormatMode::Minify).unwrap(), deep);
}
