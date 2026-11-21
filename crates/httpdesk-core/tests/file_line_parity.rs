//! The core's File line rule against the cases in `fixtures/file-lines.json`, which
//! `src/lib/http.test.ts` also runs the frontend's `parseFileRef` through: if either
//! side drifts from the expected answers, its side fails (ADR 0010).

use httpdesk_core::model::BodyMode;
use httpdesk_core::parser::{detect_body_mode, file_reference, FileReference};
use serde::Deserialize;

#[derive(Deserialize)]
struct Cases {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    case: String,
    text: String,
    file: Option<File>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct File {
    path: String,
    substitute: bool,
}

#[test]
fn the_core_reads_the_shared_file_lines() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/file-lines.json")).unwrap();
    let cases: Cases = serde_json::from_str(&text).unwrap();
    assert!(!cases.cases.is_empty());
    for c in cases.cases {
        let got = file_reference(&c.text)
            .map(|FileReference { substitute, path }| File { path: path.to_string(), substitute });
        assert_eq!(got, c.file, "{}: {:?}", c.case, c.text);
        // A body of just this text is a Whole-file body exactly when it's a File line,
        // as the page's file body editor reads it (`parseFileRef(body.text)`).
        let whole_file = detect_body_mode(Some("text/plain"), &c.text) == BodyMode::File;
        assert_eq!(whole_file, c.file.is_some(), "body mode, {}: {:?}", c.case, c.text);
    }
}
