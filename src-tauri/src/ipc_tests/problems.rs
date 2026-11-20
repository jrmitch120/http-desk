//! A request's problems, as the page gets them for the check strip and the Source
//! view's underlines: the parser's (`request_problems`, placed in the request's
//! source), and a body file that doesn't exist (`body_file_exists`, asked per file
//! the body reads). One fixture per problem code, read as a file the page opened.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::Harness;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../crates/httpdesk-core/tests/fixtures/problems");

/// A workspace holding the problem fixtures, opened.
fn workspace(h: &Harness) -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    for entry in std::fs::read_dir(FIXTURES).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, root.join(path.file_name().unwrap())).unwrap();
    }
    h.ok("open_workspace", json!({ "path": root }));
    (ws, root)
}

type Found = (usize, u64, u64, String, String);

/// Each problem the page is told of in `file`'s requests, as (request, line, column,
/// severity, code): the parser's, then a missing body file's.
fn problems_of(h: &Harness, file: &Path) -> Vec<Found> {
    let parsed = h.ok("read_http_file", json!({ "path": file }));
    let mut found = Vec::new();
    for (i, mut req) in parsed["requests"].as_array().unwrap().iter().cloned().enumerate() {
        // As the page sends it, with its own key.
        req["_key"] = json!(format!("k{i}"));
        let read = h.ok("request_problems", json!({ "request": req }));
        let mut problems: Vec<Value> = read["problems"].as_array().unwrap().clone();
        for f in read["files"].as_array().unwrap() {
            if !h.ok("body_file_exists", json!({ "file": file, "path": f["path"] })).as_bool().unwrap() {
                problems.push(f["missing"].clone());
            }
        }
        for p in problems {
            assert!(!p["message"].as_str().unwrap().is_empty(), "{p}");
            let text = |k: &str| p[k].as_str().unwrap().to_string();
            found.push((i, p["line"].as_u64().unwrap(), p["column"].as_u64().unwrap(), text("severity"), text("code")));
        }
    }
    found
}

fn problem(request: usize, line: u64, column: u64, severity: &str, code: &str) -> Found {
    (request, line, column, severity.into(), code.into())
}

#[test]
fn each_problem_code_is_reported_at_its_place_in_the_requests_source() {
    let h = Harness::new();
    let (_ws, root) = workspace(&h);
    assert_eq!(
        problems_of(&h, &root.join("unparseable-request-line.http")),
        [problem(1, 3, 1, "error", "unparseable-request-line")]
    );
    assert_eq!(
        problems_of(&h, &root.join("header-after-body.http")),
        [
            problem(0, 5, 1, "warning", "header-after-body"),
            problem(0, 6, 1, "warning", "header-after-body"),
            problem(5, 5, 1, "warning", "header-after-body")
        ]
    );
    assert_eq!(
        problems_of(&h, &root.join("unknown-directive.http")),
        [problem(1, 3, 3, "warning", "unknown-directive")]
    );
    assert_eq!(
        problems_of(&h, &root.join("missing-file.http")),
        [problem(0, 5, 1, "error", "missing-file"), problem(1, 8, 1, "error", "missing-file")]
    );
}

#[test]
fn a_body_file_exists_once_it_is_there_relative_to_the_http_files_folder() {
    let h = Harness::new();
    let (_ws, root) = workspace(&h);
    let file = root.join("missing-file.http");
    std::fs::write(root.join("payload.json"), "{}").unwrap();
    assert_eq!(problems_of(&h, &file), [problem(1, 8, 1, "error", "missing-file")]);

    // Relative to the file's folder, not the workspace root; an absolute path as written.
    std::fs::create_dir(root.join("sub")).unwrap();
    let moved = root.join("sub/missing-file.http");
    std::fs::rename(&file, &moved).unwrap();
    let exists = |path: &str| h.ok("body_file_exists", json!({ "file": moved, "path": path }));
    assert_eq!(exists("./payload.json"), json!(false));
    assert_eq!(exists("../payload.json"), json!(true));
    assert_eq!(exists(&root.join("payload.json").to_string_lossy()), json!(true));
}
