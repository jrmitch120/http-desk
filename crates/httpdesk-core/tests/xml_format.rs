//! XML Beautify and the response Pretty view: one element per line, two-space
//! indent; markup and text are copied as written, only the whitespace between
//! elements changes.

use httpdesk_core::body_format::{format_body, format_xml, BodyKind, FormatMode, MAX_DEPTH};

fn pretty(text: &str) -> String {
    format_body(text, BodyKind::Xml, FormatMode::Pretty).expect("valid XML")
}

#[test]
fn elements_go_one_per_line_and_text_only_elements_stay_on_their_line() {
    assert_eq!(pretty("<a><b>text</b><c><d>1</d></c></a>"), "<a>\n  <b>text</b>\n  <c>\n    <d>1</d>\n  </c>\n</a>");
}

#[test]
fn the_declaration_goes_on_its_own_line_and_old_indentation_is_replaced() {
    assert_eq!(
        pretty("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<a>\n\t<b>1</b>\n        <c>2</c>\n</a>\n"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<a>\n  <b>1</b>\n  <c>2</c>\n</a>"
    );
}

#[test]
fn a_doctype_with_an_internal_subset_is_one_line_copied_as_written() {
    assert_eq!(
        pretty("<?xml version=\"1.0\"?><!DOCTYPE note [\n<!ENTITY x \"a>b\">\n]><note>&x;</note>"),
        "<?xml version=\"1.0\"?>\n<!DOCTYPE note [\n<!ENTITY x \"a>b\">\n]>\n<note>&x;</note>"
    );
}

#[test]
fn comments_and_self_closing_elements_get_their_own_lines() {
    assert_eq!(
        pretty("<!-- top --><a><!-- a <b> inside --><c/><d x=\"1\" /></a>"),
        "<!-- top -->\n<a>\n  <!-- a <b> inside -->\n  <c/>\n  <d x=\"1\" />\n</a>"
    );
}

#[test]
fn a_greater_than_sign_inside_a_quoted_attribute_doesnt_end_the_tag() {
    assert_eq!(
        pretty("<a when=\"x > 1\" alt='>'><b expr=\"a>b\"/><c q='/>'>t</c></a>"),
        "<a when=\"x > 1\" alt='>'>\n  <b expr=\"a>b\"/>\n  <c q='/>'>t</c>\n</a>"
    );
}

#[test]
fn cdata_is_text_copied_as_written_even_when_it_looks_like_markup() {
    assert_eq!(
        pretty("<a><s><![CDATA[x < y && <b>]]></s><t><![CDATA[1]]> and text</t></a>"),
        "<a>\n  <s><![CDATA[x < y && <b>]]></s>\n  <t><![CDATA[1]]> and text</t>\n</a>"
    );
}

#[test]
fn an_element_mixing_text_and_children_is_copied_as_written_since_its_whitespace_is_content() {
    assert_eq!(
        pretty("<doc><p>Hello <b>world</b>,\n   again.</p><q>x</q></doc>"),
        "<doc>\n  <p>Hello <b>world</b>,\n   again.</p>\n  <q>x</q>\n</doc>"
    );
}

#[test]
fn an_element_holding_only_a_comment_is_indented_like_any_parent() {
    assert_eq!(pretty("<a><!--x--></a>"), "<a>\n  <!--x-->\n</a>");
}

#[test]
fn minify_drops_the_whitespace_between_elements_and_pretty_restores_it() {
    let pretty_form = "<?xml version=\"1.0\"?>\n<a>\n  <b>1</b>\n  <p>x <i>y</i></p>\n  <!-- c -->\n  <e/>\n</a>";
    let minified = format_xml(pretty_form, FormatMode::Minify).unwrap();
    assert_eq!(minified, "<?xml version=\"1.0\"?><a><b>1</b><p>x <i>y</i></p><!-- c --><e/></a>");
    assert_eq!(pretty(&minified), pretty_form);
}

#[test]
fn invalid_xml_is_an_error_naming_where() {
    for bad in [
        "",
        "   ",
        "just text",
        "<a>",
        "</a>",
        "<a><b></a>",
        "<a></b>",
        "<a",
        "<a x=\"1>",
        "<a/>trailing text",
        "text before<a/>",
        "<!-- never closed",
        "<a><![CDATA[never closed</a>",
        "<?xml version=\"1.0\"",
        "<>",
        "< a/>",
        "<a></ a>",
    ] {
        assert!(format_xml(bad, FormatMode::Pretty).is_err(), "{bad:?} should be rejected");
        assert!(format_xml(bad, FormatMode::Minify).is_err(), "{bad:?} should be rejected");
    }
    let err = format_xml("<a>\n  <b>\n</a>", FormatMode::Pretty).unwrap_err();
    assert_eq!(err.to_string(), "Invalid XML at line 3, column 1: expected </b>, found </a>");
}

#[test]
fn nesting_deeper_than_the_limit_is_an_error_and_up_to_it_formats() {
    let deep = |n: usize| format!("{}x{}", "<a>".repeat(n), "</a>".repeat(n));
    assert!(format_xml(&deep(MAX_DEPTH), FormatMode::Pretty).is_ok());
    let err = format_xml(&deep(MAX_DEPTH + 1), FormatMode::Pretty).unwrap_err();
    assert!(err.to_string().contains("nested"), "{err}");
}
