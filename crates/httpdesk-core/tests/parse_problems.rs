//! The problems the parser reports as it reads: one fixture per problem code
//! (`fixtures/problems/<code>.http`), with the exact place of each.

use httpdesk_core::*;

/// Each problem in `fixtures/problems/<name>` as (line, column, severity, code).
fn problems_in(name: &str) -> Vec<(usize, usize, Severity, ProblemCode)> {
    let path = format!("{}/tests/fixtures/problems/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let problems = parse_with_problems(&text).problems;
    for p in &problems {
        assert!(!p.message.is_empty(), "{p:?}");
    }
    problems.into_iter().map(|p| (p.line, p.column, p.severity, p.code)).collect()
}

#[test]
fn a_request_line_with_a_space_in_its_url_is_unparseable() {
    assert_eq!(
        problems_in("unparseable-request-line.http"),
        [(8, 1, Severity::Error, ProblemCode::UnparseableRequestLine)]
    );
}

#[test]
fn header_lines_that_start_the_body_are_headers_after_the_body() {
    assert_eq!(
        problems_in("header-after-body.http"),
        [
            (5, 1, Severity::Warning, ProblemCode::HeaderAfterBody),
            (6, 1, Severity::Warning, ProblemCode::HeaderAfterBody)
        ]
    );
}

#[test]
fn a_single_requests_problems_are_placed_in_its_own_text() {
    let parsed = parse_request("# notes\n\n###\n# @nmae x\nGET https://a b\n");
    let found: Vec<_> = parsed.problems.iter().map(|p| (p.line, p.column, p.code)).collect();
    assert_eq!(found, [(4, 3, ProblemCode::UnknownDirective), (5, 1, ProblemCode::UnparseableRequestLine)]);
}

#[test]
fn problems_are_sent_to_the_page_as_camel_case_json() {
    let parsed = parse_request("GET https://a b\n");
    let json = serde_json::to_value(&parsed.problems[0]).unwrap();
    assert_eq!(json["severity"], "error");
    assert_eq!(json["code"], "unparseable-request-line");
    assert_eq!((json["line"].as_u64(), json["column"].as_u64()), (Some(1), Some(1)));
}

#[test]
fn a_directive_no_editor_knows_is_unknown() {
    assert_eq!(problems_in("unknown-directive.http"), [(14, 3, Severity::Warning, ProblemCode::UnknownDirective)]);
}
