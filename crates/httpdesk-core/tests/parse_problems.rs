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

/// What [`request_problems`] finds in each request of `fixtures/problems/<name>`: its
/// problems, then the files its body reads, as (request, line, column, code), placed
/// in the request's text as the Source view shows it ([`render_request`]).
fn request_problems_in(name: &str) -> Vec<(usize, usize, usize, ProblemCode)> {
    let path = format!("{}/tests/fixtures/problems/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut found = Vec::new();
    for (i, req) in parse(&text).requests.iter().enumerate() {
        let read = request_problems(req);
        let missing = read.files.into_iter().map(|f| f.missing);
        found.extend(read.problems.into_iter().chain(missing).map(|p| (i, p.line, p.column, p.code)));
    }
    found
}

#[test]
fn a_requests_problems_are_placed_in_its_source() {
    use ProblemCode::*;
    assert_eq!(request_problems_in("unparseable-request-line.http"), [(1, 3, 1, UnparseableRequestLine)]);
    assert_eq!(request_problems_in("header-after-body.http"), [(0, 5, 1, HeaderAfterBody), (0, 6, 1, HeaderAfterBody)]);
    assert_eq!(request_problems_in("unknown-directive.http"), [(1, 3, 3, UnknownDirective)]);
}

#[test]
fn a_file_a_body_reads_is_named_with_the_problem_to_report_if_it_is_missing() {
    assert_eq!(
        request_problems_in("missing-file.http"),
        [(0, 5, 1, ProblemCode::MissingFile), (1, 8, 1, ProblemCode::MissingFile)]
    );
    let file = parse(
        &std::fs::read_to_string(format!("{}/tests/fixtures/problems/missing-file.http", env!("CARGO_MANIFEST_DIR")))
            .unwrap(),
    );
    let paths: Vec<_> =
        file.requests.iter().flat_map(|r| request_problems(r).files).map(|f| (f.path, f.missing.severity)).collect();
    assert_eq!(paths, [("./payload.json".to_string(), Severity::Error), ("./photo.png".to_string(), Severity::Error)]);
}

#[test]
fn only_a_file_the_body_sends_is_read() {
    let files =
        |text: &str| request_problems(&parse(text).requests[0]).files.into_iter().map(|f| f.path).collect::<Vec<_>>();
    // A `<` line among other body text is content, as the sender reads it.
    assert_eq!(
        files("POST https://e.com\nContent-Type: text/plain\n\nfirst\n< ./not-a-file.txt\n"),
        Vec::<String>::new()
    );
    // A disabled body isn't sent.
    let mut req = parse("POST https://e.com\n\n< ./payload.json\n").requests.remove(0);
    req.body.enabled = false;
    req.raw = None;
    assert_eq!(request_problems(&req).files, []);
    // Nor is a disabled multipart part.
    let multipart = "POST https://e.com\nContent-Type: multipart/form-data; boundary=B\n\n--B\n#~ Content-Disposition: form-data; name=\"a\"\n#~\n#~ < ./a.png\n--B--\n";
    assert_eq!(files(multipart), Vec::<String>::new());
}
