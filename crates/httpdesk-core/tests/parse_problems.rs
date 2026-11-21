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
            (6, 1, Severity::Warning, ProblemCode::HeaderAfterBody),
            // A text or YAML body may start with `Name: value`; a JSON body can't.
            (42, 1, Severity::Warning, ProblemCode::HeaderAfterBody)
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
/// in the request's text as the Source view shows it ([`request_source`]).
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
    assert_eq!(
        request_problems_in("header-after-body.http"),
        [(0, 5, 1, HeaderAfterBody), (0, 6, 1, HeaderAfterBody), (5, 5, 1, HeaderAfterBody)]
    );
    assert_eq!(request_problems_in("unknown-directive.http"), [(1, 3, 3, UnknownDirective)]);
}

#[test]
fn a_file_a_body_reads_is_named_with_the_problem_to_report_if_it_is_missing() {
    assert_eq!(
        request_problems_in("missing-file.http"),
        [
            (0, 5, 1, ProblemCode::MissingFile),
            (1, 8, 1, ProblemCode::MissingFile),
            (2, 6, 1, ProblemCode::MissingFile),
            (3, 6, 1, ProblemCode::MissingFile)
        ]
    );
    let file = parse(
        &std::fs::read_to_string(format!("{}/tests/fixtures/problems/missing-file.http", env!("CARGO_MANIFEST_DIR")))
            .unwrap(),
    );
    let paths: Vec<_> =
        file.requests.iter().flat_map(|r| request_problems(r).files).map(|f| (f.path, f.missing.severity)).collect();
    assert_eq!(
        paths,
        [
            ("./payload.json".to_string(), Severity::Error),
            ("./photo.png".to_string(), Severity::Error),
            ("./letter.txt".to_string(), Severity::Error),
            ("./fields.txt".to_string(), Severity::Error)
        ]
    );
}

#[test]
fn a_line_in_a_body_with_other_lines_is_not_warned_about_as_text() {
    // Never read as a file there, so nothing changed: an XML start tag over several lines is content.
    let text = "POST https://e.com\nContent-Type: text/xml\n\n<soap:Envelope\n  xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\">\n<soap:Body/>\n</soap:Envelope>\n";
    let parsed = parse_request(text);
    assert_eq!(parsed.problems, []);
    assert_eq!(parsed.files, []);
}

#[test]
fn a_line_once_read_as_a_file_is_sent_as_text_with_a_warning() {
    use ProblemCode::*;
    assert_eq!(
        problems_in("not-a-file-line.http"),
        [
            (7, 1, Severity::Warning, NotAFileLine),
            (13, 3, Severity::Warning, NotAFileLine),
            (22, 1, Severity::Warning, NotAFileLine)
        ]
    );
    // Placed in each request's text, and no file is read.
    assert_eq!(
        request_problems_in("not-a-file-line.http"),
        [(0, 5, 1, NotAFileLine), (1, 5, 3, NotAFileLine), (2, 8, 1, NotAFileLine)]
    );
    // The message says how to write the File line.
    let parsed = parse_request("POST https://e.com\n\n<@./payload.json\n");
    assert_eq!(parsed.problems[0].message, "Sent as text. Write `<@ ./payload.json` to read the file");
    assert_eq!(parsed.files, []);
}

#[test]
fn only_a_file_the_body_sends_is_read() {
    let files =
        |text: &str| request_problems(&parse(text).requests[0]).files.into_iter().map(|f| f.path).collect::<Vec<_>>();
    // Every File line of a body with other lines is read, as the sender reads it.
    assert_eq!(
        files("POST https://e.com\nContent-Type: text/plain\n\nfirst\n< ./a.txt\n<@ ./b.txt\nlast\n"),
        ["./a.txt", "./b.txt"]
    );
    // `<path` and an indented `< path` there are text.
    assert_eq!(
        files("POST https://e.com\nContent-Type: text/plain\n\nfirst\n<./a.txt\n  < ./b.txt\n"),
        Vec::<String>::new()
    );
    // A disabled body isn't sent.
    let mut req = parse("POST https://e.com\n\n< ./payload.json\n").requests.remove(0);
    req.body.enabled = false;
    req.raw = None;
    assert_eq!(request_problems(&req).files, []);
    assert_eq!(
        files("POST https://e.com\nContent-Type: text/plain\n\n#~| first\n#~| < ./a.txt\n"),
        Vec::<String>::new()
    );
    // Nor is a disabled multipart part.
    let multipart = "POST https://e.com\nContent-Type: multipart/form-data; boundary=B\n\n--B\n#~ Content-Disposition: form-data; name=\"a\"\n#~\n#~ < ./a.png\n--B--\n";
    assert_eq!(files(multipart), Vec::<String>::new());
}

#[test]
fn text_after_a_second_separator_in_a_requests_text_is_an_error_and_is_kept() {
    let text = "### List\nGET https://a\n\n### Create\nPOST https://b\n# the end\n";
    let parsed = parse_request(text);
    let found: Vec<_> = parsed.problems.iter().map(|p| (p.line, p.column, p.severity, p.code)).collect();
    assert_eq!(found, [(4, 1, Severity::Error, ProblemCode::TextAfterRequest)]);
    assert_eq!(parsed.request.as_ref().unwrap().url, "https://a");
    let following = parsed.following.expect("the text after the request");
    assert_eq!(following.requests.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(), ["https://b"]);
    assert_eq!(following.trailing, "");
    assert_eq!(request_source(&parsed.request.unwrap()) + &following.text(), text);

    // A block with no request line after it is text after the request too.
    let parsed = parse_request("GET https://a\n###\n# notes\n");
    assert_eq!(
        parsed.problems.iter().map(|p| (p.line, p.code)).collect::<Vec<_>>(),
        [(2, ProblemCode::TextAfterRequest)]
    );
    assert_eq!(parsed.following.unwrap().trailing, "###\n# notes\n");

    // The following requests' own problems are placed in the text too.
    let parsed = parse_request("GET https://a\n### B\nGET https://b c\n");
    assert_eq!(
        parsed.problems.iter().map(|p| (p.line, p.code)).collect::<Vec<_>>(),
        [(2, ProblemCode::TextAfterRequest), (3, ProblemCode::UnparseableRequestLine)]
    );
    assert_eq!(parse_request("GET https://a\n").following, None);
}

#[test]
fn a_single_requests_body_files_are_placed_in_its_own_text() {
    let parsed = parse_request("# notes\n\nPOST https://a\n\n< ./missing.json\n");
    let files: Vec<_> = parsed.files.iter().map(|f| (f.path.as_str(), f.missing.line)).collect();
    assert_eq!(files, [("./missing.json", 5)]);
}

#[test]
fn a_variable_commented_out_is_not_an_unknown_directive() {
    for text in [
        "# @host = http://localhost\nGET https://a\n",
        "// @host=http://localhost\nGET https://a\n",
        "### One\n#@token = abc\nGET https://a\n",
    ] {
        assert_eq!(parse_with_problems(text).problems, [], "{text:?}");
    }
    // A directive nobody reads still is one.
    let problems = parse_with_problems("# @nmae x\nGET https://a\n").problems;
    assert_eq!(problems.iter().map(|p| p.code).collect::<Vec<_>>(), [ProblemCode::UnknownDirective]);
}
