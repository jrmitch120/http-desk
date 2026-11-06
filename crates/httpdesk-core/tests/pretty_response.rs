//! The response Pretty view's text: JSON and XML bodies, recognised by content
//! type or (without one) by their first character, formatted losslessly.

use httpdesk_core::body_format::pretty_response;

#[test]
fn a_json_response_is_formatted_with_its_numbers_as_sent() {
    let pretty = pretty_response(Some("application/json; charset=utf-8"), r#"{"id":9007199254740993,"price":10.50}"#);
    assert_eq!(pretty, Some(Ok("{\n  \"id\": 9007199254740993,\n  \"price\": 10.50\n}".to_string())));
}

#[test]
fn json_and_xml_flavours_of_content_type_are_recognised() {
    assert_eq!(pretty_response(Some("application/problem+json"), "[1]"), Some(Ok("[\n  1\n]".into())));
    assert_eq!(pretty_response(Some("application/atom+xml"), "<a><b/></a>"), Some(Ok("<a>\n  <b/>\n</a>".into())));
    assert_eq!(pretty_response(Some("image/svg+xml"), "<svg><g/></svg>"), Some(Ok("<svg>\n  <g/>\n</svg>".into())));
}

#[test]
fn without_a_content_type_the_first_character_decides() {
    assert_eq!(pretty_response(None, "  [1]"), Some(Ok("[\n  1\n]".into())));
    assert_eq!(pretty_response(Some("text/plain"), "<a><b/></a>"), Some(Ok("<a>\n  <b/>\n</a>".into())));
    assert_eq!(pretty_response(Some("text/plain"), "hello"), None);
}

#[test]
fn html_and_other_media_have_no_pretty_text() {
    assert_eq!(pretty_response(Some("text/html"), "<p>hi</p>"), None);
    assert_eq!(pretty_response(Some("text/csv"), "a,b"), None);
    assert_eq!(pretty_response(Some("application/pdf"), "{}"), None);
}

#[test]
fn a_body_that_doesnt_parse_is_an_error() {
    let err = pretty_response(Some("application/json"), r#"{"id": 1, oops}"#).unwrap().unwrap_err();
    assert!(err.to_string().starts_with("Invalid JSON at line 1, column 11"), "{err}");
}
