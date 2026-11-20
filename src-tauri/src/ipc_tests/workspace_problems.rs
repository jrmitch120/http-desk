//! The workspace's problems, as the Problems panel gets them: every `.http` file's
//! parse problems, missing body files and lines that behave differently in VS Code
//! or Rider, by line in the file (`workspace_problems`), and one file's again after
//! an edit or a change on disk (`file_problems`). Open documents are read as the page
//! has them, unsaved edits included, instead of from disk.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::Harness;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../crates/httpdesk-core/tests/fixtures");

/// A workspace holding the problem fixtures, three portability ones (in a folder; one
/// only HttpDesk's own lines), a file with nothing to report, and a broken file in an
/// ignored folder; opened.
fn workspace(h: &Harness) -> (tempfile::TempDir, PathBuf) {
    let ws = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(ws.path()).unwrap();
    for entry in std::fs::read_dir(format!("{FIXTURES}/problems")).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, root.join(path.file_name().unwrap())).unwrap();
    }
    std::fs::create_dir(root.join("portable")).unwrap();
    for name in ["response-handler.http", "prompt-directive.http", "httpdesk-disabled-directive.http"] {
        std::fs::copy(format!("{FIXTURES}/portability/{name}"), root.join("portable").join(name)).unwrap();
    }
    std::fs::write(root.join("fine.http"), "### Fine\nGET https://example.com\n").unwrap();
    std::fs::create_dir(root.join("node_modules")).unwrap();
    std::fs::write(root.join("node_modules/broken.http"), "GET https://example.com/a b c\n").unwrap();
    h.ok("open_workspace", json!({ "path": root }));
    (ws, root)
}

/// One file's entries as (line, column, severity, code) problems and (line, support) marks.
type Entries = (Vec<(u64, u64, String, String)>, Vec<(u64, String)>);

fn entries(found: &Value) -> Entries {
    let s = |v: &Value| v.as_str().unwrap().to_string();
    let problems = found["problems"].as_array().unwrap().iter().map(|p| {
        assert!(!p["message"].as_str().unwrap().is_empty(), "{p}");
        (p["line"].as_u64().unwrap(), p["column"].as_u64().unwrap(), s(&p["severity"]), s(&p["code"]))
    });
    let marks = found["portability"].as_array().unwrap().iter().map(|m| {
        assert!(!m["hover"].as_str().unwrap().is_empty(), "{m}");
        (m["line"].as_u64().unwrap(), s(&m["support"]))
    });
    (problems.collect(), marks.collect())
}

/// What `workspace_problems` lists, by file relative to `root`.
fn listed(h: &Harness, root: &Path, open: Value) -> Vec<(String, Entries)> {
    let all = h.ok("workspace_problems", json!({ "open": open }));
    all.as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let path = Path::new(f["path"].as_str().unwrap());
            (path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), entries(f))
        })
        .collect()
}

fn problem(line: u64, column: u64, severity: &str, code: &str) -> (u64, u64, String, String) {
    (line, column, severity.into(), code.into())
}

fn mark(line: u64, support: &str) -> (u64, String) {
    (line, support.into())
}

#[test]
fn every_files_problems_and_portability_notes_are_listed_by_line_in_the_file() {
    let h = Harness::new();
    let (_ws, root) = workspace(&h);
    let mut found = listed(&h, &root, json!([]));
    found.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        found,
        [
            (
                "header-after-body.http".into(),
                (
                    vec![
                        problem(5, 1, "warning", "header-after-body"),
                        problem(6, 1, "warning", "header-after-body"),
                        problem(42, 1, "warning", "header-after-body")
                    ],
                    vec![]
                )
            ),
            // `<@` (variables in the file) is VS Code's.
            (
                "missing-file.http".into(),
                (
                    vec![problem(7, 1, "error", "missing-file"), problem(16, 1, "error", "missing-file")],
                    vec![mark(16, "vscode-only")]
                )
            ),
            // `<path` and indented `< path` lines are sent as text, so they aren't marked as files.
            (
                "not-a-file-line.http".into(),
                (
                    vec![
                        problem(7, 1, "warning", "not-a-file-line"),
                        problem(13, 3, "warning", "not-a-file-line"),
                        problem(22, 1, "warning", "not-a-file-line")
                    ],
                    vec![]
                )
            ),
            // `# @prompt` is VS Code's, a `> {% %}` handler Rider's.
            ("portable/prompt-directive.http".into(), (vec![], vec![mark(2, "vscode-only")])),
            ("portable/response-handler.http".into(), (vec![], vec![mark(4, "jetbrains-only")])),
            // `# @timeout` is Rider's, `# @prompt` and `# @note` VS Code's. HttpDesk's own lines
            // (`# @httpdesk-disabled`, `# @param`) are ignored by both, so they're no note.
            (
                "unknown-directive.http".into(),
                (
                    vec![problem(14, 3, "warning", "unknown-directive")],
                    vec![mark(4, "jetbrains-only"), mark(5, "vscode-only"), mark(6, "vscode-only")],
                ),
            ),
            (
                "unparseable-request-line.http".into(),
                (vec![problem(8, 1, "error", "unparseable-request-line")], vec![])
            ),
        ]
    );
}

/// The page finds a file's Undefined variables and shared `# @name`s itself (it knows the
/// selected environment and the Session): a file whose text has a `{{reference}}` or a
/// `@name` comes with what its text reads as, even with nothing else to report.
#[test]
fn a_file_with_references_or_names_comes_with_its_requests_as_read() {
    let h = Harness::new();
    let (_ws, root) = workspace(&h);
    std::fs::write(root.join("refs.http"), "### A\n# @name a\nGET {{host}}/{{missing}}\n").unwrap();
    let all = h.ok("workspace_problems", json!({ "open": [] }));
    let of = |name: &str| all.as_array().unwrap().iter().find(|f| f["path"].as_str().unwrap().ends_with(name)).cloned();

    let refs = of("refs.http").expect("listed for its references");
    assert_eq!(entries(&refs), (vec![], vec![]));
    assert_eq!(refs["file"]["requests"][0]["url"], "{{host}}/{{missing}}");
    assert_eq!(refs["file"]["requests"][0]["raw"], "### A\n# @name a\nGET {{host}}/{{missing}}\n");
    // A file with none, and nothing else to report, isn't listed.
    assert_eq!(of("fine.http"), None);
    // As one file again, as the page has it.
    let open = h.ok("file_problems", json!({ "path": root.join("refs.http"), "text": "GET {{other}}\n" }));
    assert_eq!(open["file"]["requests"][0]["url"], "{{other}}");
    assert_eq!(h.ok("file_problems", json!({ "path": root.join("fine.http") }))["file"], Value::Null);
}

#[test]
fn an_open_document_is_read_as_the_page_has_it_and_a_file_again_from_disk_once_it_changes() {
    let h = Harness::new();
    let (_ws, root) = workspace(&h);
    let broken = root.join("unparseable-request-line.http");

    // The page has the request line fixed, unsaved: as text (a file view's) or as the file.
    let fixed = std::fs::read_to_string(&broken).unwrap().replace("search results", "search");
    // (Listed for its `{{references}}`, with nothing to report.)
    let listed_with = |open: Value| {
        let found = listed(&h, &root, open).into_iter().find(|(p, _)| p == "unparseable-request-line.http");
        found.map(|(_, e)| e).unwrap_or_default()
    };
    assert_eq!(listed_with(json!([{ "path": broken, "text": fixed }])), (vec![], vec![]));
    let file = h.ok("parse_file_text", json!({ "text": fixed }))["file"].clone();
    assert_eq!(listed_with(json!([{ "path": broken, "file": file }])), (vec![], vec![]));
    assert_eq!(entries(&h.ok("file_problems", json!({ "path": broken, "text": fixed }))), (vec![], vec![]));

    // A body file that turns up on disk is no longer missing.
    let missing = root.join("missing-file.http");
    std::fs::write(root.join("payload.json"), "{}").unwrap();
    assert_eq!(
        entries(&h.ok("file_problems", json!({ "path": missing }))),
        (vec![problem(16, 1, "error", "missing-file")], vec![mark(16, "vscode-only")])
    );

    // Another editor breaks a file that was fine; one that's gone has nothing.
    let fine = root.join("fine.http");
    std::fs::write(&fine, "### Fine\n# @nmae fine\nGET https://example.com\n").unwrap();
    assert_eq!(
        entries(&h.ok("file_problems", json!({ "path": fine }))),
        (vec![problem(2, 3, "warning", "unknown-directive")], vec![])
    );
    std::fs::remove_file(&fine).unwrap();
    assert_eq!(h.ok("file_problems", json!({ "path": fine })), Value::Null);

    // Nothing outside the workspace is read.
    let outside = tempfile::NamedTempFile::with_suffix(".http").unwrap();
    assert!(h.call("file_problems", json!({ "path": outside.path() })).is_err());
}
