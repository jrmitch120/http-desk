//! Save as written (#164): a request whose Source view text doesn't parse is saved
//! as the request the parser recovered from that text. The file is written the way
//! the shell's `save_http_file` writes it (`try_serialize`), and read back with `parse`.

use httpdesk_core::*;

const FILE: &str = "@host = https://example.com\n\n### List\n// hand formatted\nGET   {{host}}/books\nAccept: application/json\n\n# between the two\n### Create\nPOST {{host}}/books\nContent-Type: application/json\n\n{\"title\": \"Dune\"}\n\n### Delete\nDELETE {{host}}/books/1\n";

/// `FILE` with request `index` replaced by the request recovered from `text`, saved.
fn saved_as_written(index: usize, text: &str) -> String {
    let parsed = parse_request(text);
    assert!(parsed.problems.iter().any(|p| p.severity == Severity::Error), "{text:?} should not parse");
    let mut file = parse(FILE);
    file.requests[index] = parsed.request.expect("a request line");
    try_serialize(&file).unwrap()
}

#[test]
fn a_request_saved_as_written_is_its_text_byte_for_byte_and_the_rest_of_the_file_is_unchanged() {
    let source = request_source(&parse(FILE).requests[1]);
    assert_eq!(source, "### Create\nPOST {{host}}/books\nContent-Type: application/json\n\n{\"title\": \"Dune\"}\n\n");
    let broken = source.replace("POST {{host}}/books\n", "POST {{host}}/books and more\nX-Broken header\n");

    assert_eq!(saved_as_written(1, &broken), FILE.replace(&source, &broken));
}

#[test]
fn the_first_and_last_requests_save_as_written_too() {
    let file = parse(FILE);
    for index in [0, 2] {
        let source = request_source(&file.requests[index]);
        let broken = source.replacen("{{host}}/books", "{{host}}/bo oks", 1);
        assert_eq!(saved_as_written(index, &broken), FILE.replace(&source, &broken), "request {index}");
    }
}

#[test]
fn a_file_saved_as_written_reads_back_as_the_parser_recovers_it() {
    let source = request_source(&parse(FILE).requests[1]);
    let broken = source.replace("POST {{host}}/books\n", "POST {{host}}/books and more\n");
    let text = saved_as_written(1, &broken);

    let read = parse_with_problems(&text);
    assert_eq!(read.file.requests.len(), 3);
    assert_eq!(request_source(&read.file.requests[1]), broken);
    assert_eq!(read.file.requests[1].method, "POST");
    assert!(read.problems.iter().any(|p| p.code == ProblemCode::UnparseableRequestLine), "{:?}", read.problems);
    // Saved again unchanged, it is the same text.
    assert_eq!(try_serialize(&read.file).unwrap(), text);
}
