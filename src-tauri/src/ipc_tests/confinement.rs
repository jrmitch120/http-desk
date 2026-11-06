//! Workspace confinement: every command that touches workspace files accepts
//! paths inside the open workspace and refuses `..` escapes and absolute paths
//! elsewhere on disk, without creating anything outside the workspace.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::Harness;

/// An open workspace plus a sibling folder outside it.
struct Fixture {
    h: Harness,
    _ws: tempfile::TempDir,
    _out: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let h = Harness::new();
        let ws = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let root = crate::paths::canonicalize(ws.path()).unwrap();
        let outside = crate::paths::canonicalize(out.path()).unwrap();
        h.ok("open_workspace", json!({ "path": root }));
        Fixture { h, _ws: ws, _out: out, root, outside }
    }

    /// `<root>/../<outside dir name>/<name>`: escapes the workspace via `..`.
    fn dotdot(&self, name: &str) -> PathBuf {
        self.root.join("..").join(self.outside.file_name().unwrap()).join(name)
    }

    fn rejected(&self, cmd: &str, args: Value) {
        let err = self.h.call(cmd, args).expect_err(&format!("{cmd} accepted a path outside the workspace"));
        assert!(err.as_str().unwrap().contains("outside the workspace"), "{cmd}: {err}");
    }
}

fn empty(dir: &Path) -> bool {
    std::fs::read_dir(dir).unwrap().next().is_none()
}

#[test]
fn create_file_is_confined() {
    let f = Fixture::new();
    let content = "GET https://a\n";
    f.h.ok("create_file", json!({ "path": f.root.join("a.http"), "content": content }));
    assert!(f.root.join("a.http").exists());

    f.rejected("create_file", json!({ "path": f.dotdot("x.http"), "content": content }));
    f.rejected("create_file", json!({ "path": f.outside.join("x.http"), "content": content }));
    f.rejected("create_file", json!({ "path": f.outside.join("new/dir/x.http"), "content": content }));
    assert!(empty(&f.outside), "nothing is created outside the workspace");
}

#[test]
fn read_http_file_is_confined() {
    let f = Fixture::new();
    std::fs::write(f.root.join("a.http"), "GET https://a\n").unwrap();
    std::fs::write(f.outside.join("x.http"), "GET https://secret\n").unwrap();
    let file = f.h.ok("read_http_file", json!({ "path": f.root.join("a.http") }));
    assert_eq!(file["requests"][0]["url"], "https://a");

    f.rejected("read_http_file", json!({ "path": f.dotdot("x.http") }));
    f.rejected("read_http_file", json!({ "path": f.outside.join("x.http") }));
}

#[cfg(unix)]
#[test]
fn symlinked_folder_pointing_outside_is_outside() {
    let f = Fixture::new();
    std::fs::write(f.outside.join("x.http"), "GET https://secret\n").unwrap();
    std::os::unix::fs::symlink(&f.outside, f.root.join("link")).unwrap();
    f.rejected("read_http_file", json!({ "path": f.root.join("link/x.http") }));
    f.rejected("create_file", json!({ "path": f.root.join("link/y.http"), "content": "" }));
    assert!(!f.outside.join("y.http").exists());
}

#[test]
fn save_http_file_is_confined() {
    let f = Fixture::new();
    std::fs::write(f.root.join("a.http"), "GET https://a\n").unwrap();
    let file = f.h.ok("read_http_file", json!({ "path": f.root.join("a.http") }));
    f.h.ok("save_http_file", json!({ "path": f.root.join("sub/b.http"), "file": file }));
    assert!(f.root.join("sub/b.http").exists());

    f.rejected("save_http_file", json!({ "path": f.dotdot("x.http"), "file": file }));
    f.rejected("save_http_file", json!({ "path": f.outside.join("x.http"), "file": file }));
    f.rejected("save_http_file", json!({ "path": f.dotdot("new/x.http"), "file": file }));
    assert!(empty(&f.outside), "nothing is written outside the workspace");
}

#[test]
fn create_dir_is_confined() {
    let f = Fixture::new();
    f.h.ok("create_dir", json!({ "path": f.root.join("api/users") }));
    assert!(f.root.join("api/users").is_dir());

    f.rejected("create_dir", json!({ "path": f.dotdot("x") }));
    f.rejected("create_dir", json!({ "path": f.root.join("api/../../x") }));
    f.rejected("create_dir", json!({ "path": f.outside.join("x/y") }));
    assert!(empty(&f.outside), "no folder is created outside the workspace");
}

#[test]
fn rename_path_is_confined() {
    let f = Fixture::new();
    std::fs::write(f.root.join("a.http"), "GET https://a\n").unwrap();
    std::fs::write(f.outside.join("x.http"), "GET https://x\n").unwrap();
    f.h.ok("rename_path", json!({ "from": f.root.join("a.http"), "to": f.root.join("api/b.http") }));
    assert!(f.root.join("api/b.http").exists() && !f.root.join("a.http").exists());

    let inside = f.root.join("api/b.http");
    // Moving out of the workspace, by `..` or absolute path.
    f.rejected("rename_path", json!({ "from": inside, "to": f.dotdot("b.http") }));
    f.rejected("rename_path", json!({ "from": inside, "to": f.outside.join("new/b.http") }));
    // Pulling a file in from outside.
    f.rejected("rename_path", json!({ "from": f.dotdot("x.http"), "to": f.root.join("x.http") }));
    f.rejected("rename_path", json!({ "from": f.outside.join("x.http"), "to": f.root.join("x.http") }));
    // Moving the workspace folder itself.
    assert!(f.h.call("rename_path", json!({ "from": f.root, "to": f.root.join("moved") })).is_err());

    assert!(inside.exists());
    let left: Vec<_> = std::fs::read_dir(&f.outside).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left, vec![std::ffi::OsString::from("x.http")], "outside folder untouched");
}

#[test]
fn delete_path_is_confined() {
    let f = Fixture::new();
    std::fs::write(f.root.join("a.http"), "GET https://a\n").unwrap();
    std::fs::write(f.outside.join("x.http"), "GET https://x\n").unwrap();

    f.rejected("delete_path", json!({ "path": f.dotdot("x.http") }));
    f.rejected("delete_path", json!({ "path": f.outside.join("x.http") }));
    assert!(f.h.call("delete_path", json!({ "path": f.root })).is_err(), "the workspace itself can't be deleted");
    assert!(f.outside.join("x.http").exists() && f.root.join("a.http").exists());

    f.h.ok("delete_path", json!({ "path": f.root.join("a.http") }));
    assert!(!f.root.join("a.http").exists());
}

#[test]
fn openapi_generate_output_is_confined() {
    let f = Fixture::new();
    let spec = f.root.join("spec.yaml");
    std::fs::write(
        &spec,
        "openapi: 3.0.3\ninfo: {title: Mini, version: '1'}\nservers: [{url: 'https://api.mini.dev'}]\npaths:\n  /things:\n    get:\n      operationId: listThings\n      tags: [things]\n      responses: {'200': {description: ok}}\n",
    )
    .unwrap();
    let source = spec.to_string_lossy().to_string();
    f.h.ok("openapi_load", json!({ "source": source }));
    let generate = |out: PathBuf, dry_run: bool| {
        json!({ "source": source, "options": { "operationIds": [], "grouping": "tag", "baseUrlVariable": "baseUrl", "singleFileName": null },
                "outputDir": out, "overwrite": false, "dryRun": dry_run })
    };

    let done = f.h.ok("openapi_generate", generate(f.root.join("mini"), false));
    assert_eq!(done["written"], true);
    assert!(f.root.join("mini/things.http").exists());

    for dry_run in [true, false] {
        f.rejected("openapi_generate", generate(f.dotdot("mini"), dry_run));
        f.rejected("openapi_generate", generate(f.outside.join("mini"), dry_run));
        f.rejected("openapi_generate", generate(f.root.join("mini/../../x"), dry_run));
        // A single-file name typed by the user can't climb out either.
        let mut args = generate(f.root.clone(), dry_run);
        args["options"]["grouping"] = json!("single");
        args["options"]["singleFileName"] = json!(format!("../{}/escape", f.outside.file_name().unwrap().to_string_lossy()));
        f.rejected("openapi_generate", args);
    }
    assert!(empty(&f.outside), "nothing is generated outside the workspace");
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn case_only_rename() {
    let f = Fixture::new();
    std::fs::write(f.root.join("api.http"), "GET https://a\n").unwrap();
    f.h.ok("rename_path", json!({ "from": f.root.join("api.http"), "to": f.root.join("API.http") }));
    assert_eq!(names(&f.root), ["API.http"]);
}

#[test]
fn rename_never_replaces_another_file() {
    let f = Fixture::new();
    std::fs::write(f.root.join("a.http"), "GET https://a\n").unwrap();
    std::fs::write(f.root.join("b.http"), "GET https://b\n").unwrap();
    let case_insensitive = f.root.join("A.HTTP").exists();

    let err = f.h.call("rename_path", json!({ "from": f.root.join("a.http"), "to": f.root.join("b.http") })).unwrap_err();
    assert!(err.as_str().unwrap().contains("already exists"), "{err}");
    let to_other_case = f.h.call("rename_path", json!({ "from": f.root.join("a.http"), "to": f.root.join("B.http") }));
    assert_eq!(to_other_case.is_err(), case_insensitive, "{to_other_case:?}");
    assert_eq!(std::fs::read_to_string(f.root.join("b.http")).unwrap(), "GET https://b\n");
}
