//! The portability table: one fixture per row (`fixtures/portability/<construct>.http`),
//! classified as the editors' documentation says, on the line the construct is written.

use std::collections::BTreeSet;

use httpdesk_core::portability::{portability, request_portability, Construct, Support, TABLE};

use Construct as C;
use Support::*;

/// Each row's construct, how the two editors' docs classify it (an independent
/// reading, not the table's), and the line its fixture writes it on.
const ROWS: &[(Construct, Support, usize)] = &[
    (C::NameDirective, Portable, 2),
    (C::NoRedirectDirective, Portable, 2),
    (C::NoCookieJarDirective, Portable, 2),
    (C::NoLogDirective, JetbrainsOnly, 2),
    (C::NoAutoEncodingDirective, JetbrainsOnly, 2),
    (C::TimeoutDirective, JetbrainsOnly, 2),
    (C::ConnectionTimeoutDirective, JetbrainsOnly, 2),
    (C::UseOsCredentialsDirective, JetbrainsOnly, 2),
    (C::NoteDirective, VscodeOnly, 2),
    (C::PromptDirective, VscodeOnly, 2),
    (C::HttpdeskDisabledDirective, HttpdeskOnly, 2),
    (C::HttpdeskAuthDirective, HttpdeskOnly, 2),
    (C::DocDirective, HttpdeskOnly, 2),
    (C::DisabledLine, HttpdeskOnly, 3),
    (C::ResponseHandler, JetbrainsOnly, 4),
    (C::PreRequestScript, JetbrainsOnly, 2),
    (C::ResponseRedirect, JetbrainsOnly, 4),
    (C::FileVariable, Portable, 1),
    (C::RequestVariable, VscodeOnly, 7),
    (C::Timestamp, Portable, 2),
    (C::JetbrainsDynamicVariable, JetbrainsOnly, 3),
    (C::RandomInt, JetbrainsOnly, 2),
    (C::VscodeDynamicVariable, VscodeOnly, 3),
    (C::VscodeSignInVariable, VscodeOnly, 3),
    (C::ExampleServer, JetbrainsOnly, 2),
    (C::RandomIntRange, VscodeOnly, 2),
    (C::TimestampOffset, VscodeOnly, 2),
    (C::GraphqlRequestTypeHeader, VscodeOnly, 4),
    (C::GraphqlMethod, JetbrainsOnly, 2),
    (C::BodyFile, Portable, 5),
    (C::BodyFileWithVariables, VscodeOnly, 5),
    (C::BodyFileLine, VscodeOnly, 6),
];

fn fixture(construct: Construct) -> String {
    let path = format!("{}/tests/fixtures/portability/{}.http", env!("CARGO_MANIFEST_DIR"), construct.id());
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn each_rows_fixture_is_classified_as_the_editors_document_it() {
    for &(construct, support, line) in ROWS {
        let marks = portability(&fixture(construct));
        let found: Vec<_> = marks.iter().filter(|m| m.construct == construct).map(|m| (m.line, m.support)).collect();
        assert_eq!(found, [(line, support)], "{}: {marks:#?}", construct.id());
    }
}

#[test]
fn every_row_is_tested_once() {
    let tested: BTreeSet<_> = ROWS.iter().map(|r| r.0.id()).collect();
    let rows: Vec<_> = TABLE.iter().map(|r| r.construct.id()).collect();
    let table: BTreeSet<_> = rows.iter().copied().collect();
    assert_eq!(rows.len(), table.len(), "a construct has two rows");
    assert_eq!(table, tested);
}

/// A citation is a page of either editor's documentation (or its first-party issue
/// tracker or source), or a research note in this repository that records the evidence.
fn is_citation(c: &str) -> bool {
    const SOURCES: &[&str] = &[
        "https://www.jetbrains.com/help/idea/",
        "https://youtrack.jetbrains.com/issue/",
        "https://github.com/Huachao/vscode-restclient/",
    ];
    if SOURCES.iter().any(|s| c.starts_with(s)) {
        return true;
    }
    let path = c.split('#').next().unwrap();
    path.starts_with("docs/") && std::path::Path::new(&format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"))).is_file()
}

#[test]
fn every_row_cites_both_editors_documentation() {
    for row in TABLE {
        let id = row.construct.id();
        assert!(!row.jetbrains.is_empty() && !row.vscode.is_empty(), "{id} cites no source for one editor");
        for c in row.jetbrains.iter().chain(row.vscode) {
            assert!(is_citation(c), "{id}: {c} isn't an editor's documentation or a research note in docs/");
        }
        assert!(!row.label.is_empty() && !row.hover.is_empty(), "{id}");
    }
}

#[test]
fn script_text_is_not_read_for_constructs() {
    // The handler fixture's script mentions `// @no-log` and `{{$guid}}`: neither is a construct there.
    let marks = portability(&fixture(C::ResponseHandler));
    assert_eq!(marks.iter().map(|m| m.construct).collect::<Vec<_>>(), [C::ResponseHandler]);
}

#[test]
fn a_construct_is_marked_once_per_line() {
    let marks = portability("GET https://example.com/?a={{$uuid}}&b={{$uuid}}&c={{$guid}}\n");
    let found: Vec<_> = marks.iter().map(|m| (m.line, m.construct)).collect();
    assert_eq!(found, [(1, C::JetbrainsDynamicVariable), (1, C::VscodeDynamicVariable)]);
}

#[test]
fn lines_count_from_the_start_of_the_text_across_requests_and_line_endings() {
    let text = "\u{FEFF}@host = a\r\n\r\n### One\r\n# @no-log\r\nGET https://{{host}}/\r\n\r\n### Two\r\n# @note\r\nGET https://{{host}}/\r\n";
    let found: Vec<_> = portability(text).iter().map(|m| (m.line, m.construct)).collect();
    assert_eq!(found, [(1, C::FileVariable), (4, C::NoLogDirective), (8, C::NoteDirective)]);
}

#[test]
fn disabled_lines_are_httpdesk_only_and_their_contents_are_not_read() {
    let text = "GET https://example.com/\n#~ X-Id: {{$guid}}\n#~| {\"at\": \"{{$timestamp -1 d}}\"}\n";
    let found: Vec<_> = portability(text).iter().map(|m| (m.line, m.construct)).collect();
    assert_eq!(found, [(2, C::DisabledLine), (3, C::DisabledLine)]);
}

#[test]
fn only_a_file_line_is_marked_as_a_file() {
    let marked = |body: &str| {
        let text = format!("POST https://example.com/\nContent-Type: application/json\n\n{body}\n");
        portability(&text).iter().map(|m| (m.line, m.construct)).collect::<Vec<_>>()
    };
    assert_eq!(marked("<\t./a.json  "), [(4, C::BodyFile)]);
    assert_eq!(marked("<./a.json"), []);
    assert_eq!(marked("<@./a.json"), []);
    assert_eq!(marked("  < ./a.json"), []);
    assert_eq!(marked("  <@ ./a.json"), []);
    // Among other lines: `< file` is spliced differently by each editor, `<@ file` is VS Code's anywhere.
    assert_eq!(marked("[\n< ./a.json\n<@ ./b.json\n]"), [(5, C::BodyFileLine), (6, C::BodyFileWithVariables)]);
    assert_eq!(marked("[\n<./a.json\n  < ./b.json\n]"), []);
    // A multipart part's file is read alone, as a Whole-file body is.
    let multipart = "POST https://example.com/\nContent-Type: multipart/form-data; boundary=B\n\n--B\nContent-Disposition: form-data; name=\"f\"; filename=\"a.png\"\n\n< ./a.png\n--B--\n";
    let found: Vec<_> = portability(multipart).iter().map(|m| (m.line, m.construct)).collect();
    assert_eq!(found, [(7, C::BodyFile)]);
}

#[test]
fn a_file_rows_hover_says_what_each_editor_sends() {
    let hover = |c: Construct| portability(&fixture(c)).into_iter().find(|m| m.construct == c).unwrap().hover;
    assert_eq!(
        hover(C::BodyFile),
        "Both editors send this file's content; Rider also fills in {{variables}} written in the file"
    );
    assert_eq!(
        hover(C::BodyFileWithVariables),
        "VS Code sends this file's content with its {{variables}} filled in; Rider sends the line as text"
    );
    assert_eq!(
        hover(C::BodyFileLine),
        "VS Code puts this file's content in place of the line; Rider does too, but drops the line breaks around it"
    );
}

#[test]
fn marks_are_sent_to_the_page_as_json_with_their_hover() {
    let marks = portability(&fixture(C::ResponseHandler));
    let json = serde_json::to_value(&marks[0]).unwrap();
    assert_eq!(json["line"], 4);
    assert_eq!(json["construct"], "response-handler");
    assert_eq!(json["support"], "jetbrains-only");
    let hover = json["hover"].as_str().unwrap();
    assert!(hover.contains("Rider runs") && hover.contains("VS Code ignores"), "{hover}");
}

#[test]
fn a_requests_marks_are_placed_in_its_source_as_the_source_view_shows_it() {
    // The text before the request comes first, and the block is as written (its blank
    // line and spacing kept), so the marks fall on the lines shown.
    let text = "# Notes\n\n### Pets\n\n# @no-log\nGET   https://example.com/\n#~ X-Debug: on\n";
    let request = httpdesk_core::parse_request(text).request.unwrap();
    assert_eq!(httpdesk_core::request_source(&request), text);
    let found: Vec<_> = request_portability(&request).iter().map(|m| (m.line, m.construct)).collect();
    assert_eq!(found, [(5, C::NoLogDirective), (7, C::DisabledLine)]);
}
