//! Workspace helpers: directory tree, request search, atomic writes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{AuthKind, BodyMode, HttpFile, KvSection, Request};

pub const HTTP_EXTENSIONS: &[&str] = &["http", "rest"];
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", "venv"];
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: PathBuf,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

pub fn is_http_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| HTTP_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Whether the explorer skips a folder with this name: dot-folders (`.git`,
/// `.venv`, `.cache`, …), dependencies, build output, virtualenvs and caches.
/// The watcher uses the same rule, so churn the explorer doesn't show causes no reloads.
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// Whether `path` lies inside an ignored folder below `root`. The folders `root`
/// itself sits in don't count, nor does `path`'s own name.
pub fn inside_ignored_dir(root: &Path, path: &Path) -> bool {
    let Some(dirs) = path.strip_prefix(root).ok().and_then(Path::parent) else { return false };
    dirs.components().any(|c| is_ignored_dir(&c.as_os_str().to_string_lossy()))
}

/// Lists directories and `.http`/`.rest` files under `root`, directories first.
pub fn tree(root: &Path) -> std::io::Result<TreeNode> {
    let mut budget = MAX_ENTRIES;
    let children = list_dir(root, &mut budget, 0)?;
    Ok(TreeNode {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string()),
        path: root.to_path_buf(),
        kind: NodeKind::Dir,
        children: Some(children),
    })
}

fn list_dir(dir: &Path, budget: &mut usize, depth: usize) -> std::io::Result<Vec<TreeNode>> {
    let mut nodes = Vec::new();
    if depth > 16 {
        return Ok(nodes);
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        if *budget == 0 {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if is_ignored_dir(&name) {
                continue;
            }
            *budget -= 1;
            let children = list_dir(&path, budget, depth + 1).unwrap_or_default();
            nodes.push(TreeNode { name, path, kind: NodeKind::Dir, children: Some(children) });
        } else if is_http_file(&path) {
            *budget -= 1;
            nodes.push(TreeNode { name, path, kind: NodeKind::File, children: None });
        }
    }
    nodes.sort_by_key(|n| n.kind != NodeKind::Dir);
    Ok(nodes)
}

/// All `.http` files under `root` (same filtering as [`tree`]).
pub fn http_files(root: &Path) -> Vec<PathBuf> {
    fn walk(node: &TreeNode, out: &mut Vec<PathBuf>) {
        match node.kind {
            NodeKind::File => out.push(node.path.clone()),
            NodeKind::Dir => node.children.iter().flatten().for_each(|c| walk(c, out)),
        }
    }
    let mut out = Vec::new();
    if let Ok(t) = tree(root) {
        walk(&t, &mut out);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: PathBuf,
    pub index: usize,
    pub name: String,
    pub method: String,
    pub url: String,
}

/// Case-insensitive search over request names, methods and URLs.
pub fn search(root: &Path, query: &str) -> Vec<SearchHit> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut hits = Vec::new();
    for path in http_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        for (index, req) in crate::parse(&text).requests.iter().enumerate() {
            let name = req.display_name();
            let haystack = format!("{} {} {} {}", name, req.method, req.url, file_name).to_lowercase();
            if terms.iter().all(|t| haystack.contains(t)) {
                hits.push(SearchHit {
                    path: path.clone(),
                    index,
                    name,
                    method: req.method.clone(),
                    url: req.url.clone(),
                });
            }
            if hits.len() >= 500 {
                return hits;
            }
        }
    }
    hits
}

/// One `{{name}}` reference found by [`usages`]. `start`..`end` is where it sits in
/// the text of its field (braces included), in UTF-16 code units, so the frontend
/// can slice the field's string with them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Usage {
    /// In a request: `index` is its position in the file's `requests`; `name`,
    /// `method` and `url` identify it as [`SearchHit`] does. `disabled` when the
    /// reference isn't sent (a disabled param, header, auth or body, or a section
    /// that's off).
    Request {
        path: PathBuf,
        index: usize,
        name: String,
        method: String,
        url: String,
        field: RequestField,
        disabled: bool,
        start: usize,
        end: usize,
    },
    /// In the value of a File variable at the top of the file (`FileHeader::variables[index]`, named `name`).
    FileVariable { path: PathBuf, index: usize, name: String, start: usize, end: usize },
    /// In the value of variable `name` of environment `env` (`$shared` for the
    /// shared variables). `path` is the env file holding the value: the private
    /// one for a Secret.
    Environment { path: PathBuf, env: String, name: String, secret: bool, start: usize, end: usize },
}

/// The field of a request a reference is in. `index` counts into the request's
/// `query.items`, `headers.items` or `variables`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequestField {
    /// The URL without its query string (`Request::url`).
    Url,
    Param {
        index: usize,
        name: String,
        part: Part,
    },
    Header {
        index: usize,
        name: String,
        part: Part,
    },
    /// The field of the request's auth kind (Basic: username, password; Bearer:
    /// token; API key: its value).
    Auth {
        part: AuthPart,
    },
    /// `Body::text`, whatever the body mode (form fields and multipart parts are lines of it).
    Body,
    /// The value of one of the request's own `@name = value` lines (a File variable).
    Variable {
        index: usize,
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthPart {
    Username,
    Password,
    Token,
    KeyValue,
}

/// Which side of a param or header a reference is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Name,
    Value,
}

/// Every `{{name}}` reference in the workspace: in the `.http` files, in explorer
/// order (File variables at the top of a file, then each request), then in the
/// values of the environment files at the root. `open` holds documents as the app
/// has them (unsaved edits included); they're used instead of the files on disk at
/// the same paths. Unreadable files and env files are skipped.
pub fn usages(root: &Path, name: &str, open: &[(PathBuf, HttpFile)]) -> Vec<Usage> {
    let mut out = Vec::new();
    for path in http_files(root) {
        let parsed;
        let file = match open.iter().find(|(p, _)| *p == path) {
            Some((_, f)) => f,
            None => {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                parsed = crate::parse(&text);
                &parsed
            }
        };
        for (index, v) in file.header.variables.iter().enumerate() {
            for (_, start, end) in positions(&v.value, name) {
                out.push(Usage::FileVariable { path: path.clone(), index, name: v.name.clone(), start, end });
            }
        }
        for (index, req) in file.requests.iter().enumerate() {
            for (field, text, off) in request_fields(req) {
                for (bytes, start, end) in positions(text, name) {
                    // A disabled form field or multipart part is a `#~` line of the body (ADR-0003).
                    let disabled = off || (field == RequestField::Body && disabled_line(text, bytes.start));
                    out.push(Usage::Request {
                        path: path.clone(),
                        index,
                        name: req.display_name(),
                        method: req.method.clone(),
                        url: req.url.clone(),
                        field: field.clone(),
                        disabled,
                        start,
                        end,
                    });
                }
            }
        }
    }
    let below = crate::env::folders(root).unwrap_or_default();
    for (dir, set) in
        std::iter::once(root.to_path_buf()).chain(below).filter_map(|d| Some((d.clone(), crate::env::load(&d).ok()?)))
    {
        let envs = std::iter::once((crate::env::SHARED, &set.shared))
            .chain(set.environments.iter().map(|e| (e.name.as_str(), &e.variables)));
        for (env, vars) in envs {
            for v in vars {
                let path = dir.join(if v.secret { crate::env::PRIVATE_ENV_FILE } else { crate::env::ENV_FILE });
                for (_, start, end) in positions(&v.value, name) {
                    let (env, name, secret) = (env.to_string(), v.name.clone(), v.secret);
                    out.push(Usage::Environment { path: path.clone(), env, name, secret, start, end });
                }
            }
        }
    }
    out
}

/// The fields of a request that can hold references: (field, text, disabled).
fn request_fields(req: &Request) -> Vec<(RequestField, &str, bool)> {
    fn items(section: &KvSection, make: fn(usize, String, Part) -> RequestField) -> Vec<(RequestField, &str, bool)> {
        let mut out = Vec::new();
        for (i, kv) in section.items.iter().enumerate() {
            let off = !section.enabled || !kv.enabled;
            out.push((make(i, kv.name.clone(), Part::Name), kv.name.as_str(), off));
            out.push((make(i, kv.name.clone(), Part::Value), kv.value.as_str(), off));
        }
        out
    }
    let variables = req.variables.iter().enumerate();
    let mut out: Vec<_> = variables
        .map(|(index, v)| (RequestField::Variable { index, name: v.name.clone() }, v.value.as_str(), false))
        .collect();
    out.push((RequestField::Url, req.url.as_str(), false));
    out.extend(items(&req.query, |index, name, part| RequestField::Param { index, name, part }));
    out.extend(items(&req.headers, |index, name, part| RequestField::Header { index, name, part }));
    let auth = &req.auth;
    let auth_fields: &[(AuthPart, &str)] = match auth.kind {
        AuthKind::None => &[],
        AuthKind::Basic => &[(AuthPart::Username, &auth.username), (AuthPart::Password, &auth.password)],
        AuthKind::Bearer => &[(AuthPart::Token, &auth.token)],
        AuthKind::ApiKey => &[(AuthPart::KeyValue, &auth.key_value)],
    };
    out.extend(auth_fields.iter().map(|(part, text)| (RequestField::Auth { part: *part }, *text, !auth.enabled)));
    if req.body.mode != BodyMode::None {
        out.push((RequestField::Body, req.body.text.as_str(), !req.body.enabled));
    }
    out
}

/// Whether the line of `text` holding byte `at` is a disabled (`#~`) line.
fn disabled_line(text: &str, at: usize) -> bool {
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    text[line_start..].trim_start().starts_with(crate::parser::DISABLED_MARKER)
}

/// Where `{{name}}` occurs in `text`: its byte range, and its start and end as UTF-16 offsets.
fn positions<'a>(text: &'a str, name: &'a str) -> impl Iterator<Item = (std::ops::Range<usize>, usize, usize)> + 'a {
    let utf16 = |byte: usize| text[..byte].encode_utf16().count();
    crate::vars::references(text).filter(move |(_, n)| *n == name).map(move |(r, _)| {
        let (start, end) = (utf16(r.start), utf16(r.end));
        (r, start, end)
    })
}

/// Follows a chain of symlinks to the file it ends at (which may not exist yet).
/// Paths that aren't symlinks are returned unchanged.
pub fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut path = path.to_path_buf();
    for _ in 0..40 {
        let Ok(link) = std::fs::read_link(&path) else { break };
        path = match path.parent() {
            Some(parent) if link.is_relative() => parent.join(link),
            _ => link,
        };
    }
    path
}

/// Writes via a temp file + rename so watchers never observe partial content.
/// A symlink is written through to its target, and an existing file keeps its
/// permissions.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let path = &resolve_symlinks(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.httpdesk-tmp",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let permissions = std::fs::metadata(path).ok().map(|m| m.permissions());
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        // Apply the mode before any content lands, so a `chmod 600` file is never readable by others.
        if let Some(p) = permissions {
            f.set_permissions(p)?;
        }
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Cheap content fingerprint used for self-write suppression.
pub fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("api/users")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(
            root.join("api/users/users.http"),
            "### List users\nGET https://x/users\n\n### Create user\nPOST https://x/users\n",
        )
        .unwrap();
        std::fs::write(root.join("node_modules/x/a.http"), "GET https://ignored\n").unwrap();
        std::fs::write(root.join("readme.md"), "").unwrap();
        write_atomic(&root.join("a.rest"), b"GET https://x/a\n").unwrap();

        let t = tree(root).unwrap();
        let names: Vec<_> = t.children.as_ref().unwrap().iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["api", "a.rest"]);
        assert_eq!(http_files(root).len(), 2);

        let hits = search(root, "post users");
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].name.as_str(), hits[0].index), ("Create user", 1));
        assert_eq!(search(root, "users.http").len(), 2);
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    fn workspace(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    /// (request name, field, disabled) of each reference in a request.
    fn fields(usages: &[Usage]) -> Vec<(String, RequestField, bool)> {
        usages
            .iter()
            .filter_map(|u| match u {
                Usage::Request { name, field, disabled, .. } => Some((name.clone(), field.clone(), *disabled)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn finds_references_in_url_params_and_headers_marking_disabled_ones() {
        let dir = workspace(&[(
            "api/users.http",
            "### List users\nGET {{host}}/users?page={{ host }}\n#~ &debug={{host}}\nX-Host: {{host}}\n#~ X-Off: {{host}}\nX-Other: {{hostname}}\n",
        )]);
        let usages = usages(dir.path(), "host", &[]);
        let header = |index, name: &str| RequestField::Header { index, name: name.into(), part: Part::Value };
        let param = |index, name: &str| RequestField::Param { index, name: name.into(), part: Part::Value };
        assert_eq!(
            fields(&usages),
            [
                ("List users".into(), RequestField::Url, false),
                ("List users".into(), param(0, "page"), false),
                ("List users".into(), param(1, "debug"), true),
                ("List users".into(), header(0, "X-Host"), false),
                ("List users".into(), header(1, "X-Off"), true),
            ]
        );
        let Usage::Request { path, index, method, url, .. } = &usages[0] else { panic!("{usages:?}") };
        assert_eq!(
            (path, *index, method.as_str(), url.as_str()),
            (&dir.path().join("api/users.http"), 0, "GET", "{{host}}/users")
        );
    }

    #[test]
    fn finds_references_in_auth_body_and_a_requests_own_variables() {
        let dir = workspace(&[(
            "a.http",
            "### Basic\nGET https://x\nAuthorization: Basic {{user}} {{user}}pw\n\n\
             ### Bearer\n@me = {{user}}-1\nGET https://x\nAuthorization: Bearer {{user}}\n\n\
             ### Form\nPOST https://x\nContent-Type: application/x-www-form-urlencoded\n\nname={{user}}\n#~ &alias={{user}}\n",
        )]);
        let got = fields(&usages(dir.path(), "user", &[]));
        assert_eq!(
            got,
            [
                ("Basic".into(), RequestField::Auth { part: AuthPart::Username }, false),
                ("Basic".into(), RequestField::Auth { part: AuthPart::Password }, false),
                ("Bearer".into(), RequestField::Variable { index: 0, name: "me".into() }, false),
                ("Bearer".into(), RequestField::Auth { part: AuthPart::Token }, false),
                ("Form".into(), RequestField::Body, false),
                ("Form".into(), RequestField::Body, true),
            ]
        );
    }

    #[test]
    fn a_disabled_auth_or_body_is_marked_disabled() {
        let dir = workspace(&[(
            "a.http",
            "### Off\nPOST https://x\n#~ Authorization: Bearer {{t}}\nContent-Type: text/plain\n\n#~| hello {{t}}\n",
        )]);
        let got = fields(&usages(dir.path(), "t", &[]));
        assert_eq!(
            got,
            [
                ("Off".into(), RequestField::Auth { part: AuthPart::Token }, true),
                ("Off".into(), RequestField::Body, true)
            ]
        );
    }

    #[test]
    fn positions_are_utf16_offsets_into_the_fields_text() {
        let dir = workspace(&[("a.http", "GET https://x/é/{{ id }}/😀{{id}}\n")]);
        let got: Vec<_> = usages(dir.path(), "id", &[])
            .into_iter()
            .map(|u| match u {
                Usage::Request { start, end, .. } => (start, end),
                _ => panic!(),
            })
            .collect();
        // "https://x/é/" is 12 units, "{{ id }}" 8; "/😀" is 3 more.
        assert_eq!(got, [(12, 20), (23, 29)]);
    }

    #[test]
    fn finds_references_in_file_variables_and_environment_values() {
        let dir = workspace(&[
            ("a.http", "@base = {{host}}/api\n@other = x\n\n### One\nGET {{base}}\n"),
            (
                "http-client.env.json",
                r#"{ "$shared": { "api": "{{host}}/v1" }, "dev": { "host": "h", "url": "{{host}}" } }"#,
            ),
            ("http-client.private.env.json", r#"{ "dev": { "token": "{{ host }}-secret" } }"#),
        ]);
        let root = dir.path();
        let public = root.join("http-client.env.json");
        let private = root.join("http-client.private.env.json");
        assert_eq!(
            usages(root, "host", &[]),
            [
                Usage::FileVariable { path: root.join("a.http"), index: 0, name: "base".into(), start: 0, end: 8 },
                Usage::Environment {
                    path: public.clone(),
                    env: "$shared".into(),
                    name: "api".into(),
                    secret: false,
                    start: 0,
                    end: 8
                },
                Usage::Environment {
                    path: public,
                    env: "dev".into(),
                    name: "url".into(),
                    secret: false,
                    start: 0,
                    end: 8
                },
                Usage::Environment {
                    path: private,
                    env: "dev".into(),
                    name: "token".into(),
                    secret: true,
                    start: 0,
                    end: 10
                },
            ]
        );
    }

    #[test]
    fn finds_references_in_every_folders_env_files() {
        let dir = workspace(&[
            ("api/users/http-client.private.env.json", r#"{ "dev": { "token": "{{host}}" } }"#),
            ("api/http-client.env.json", r#"{ "$shared": { "base": "{{host}}/api" } }"#),
            ("http-client.env.json", r#"{ "dev": { "url": "{{host}}" } }"#),
            ("node_modules/x/http-client.env.json", r#"{ "dev": { "url": "{{host}}" } }"#),
        ]);
        let root = dir.path();
        let got: Vec<_> = usages(root, "host", &[])
            .into_iter()
            .map(|u| match u {
                Usage::Environment { path, env, name, .. } => {
                    (path.strip_prefix(root).unwrap().to_path_buf(), env, name)
                }
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            got,
            [
                ("http-client.env.json".into(), "dev".into(), "url".into()),
                ("api/http-client.env.json".into(), "$shared".into(), "base".into()),
                ("api/users/http-client.private.env.json".into(), "dev".into(), "token".into()),
            ]
        );
    }

    #[test]
    fn open_documents_are_searched_as_given_and_every_file_in_explorer_order() {
        let dir = workspace(&[
            ("b.http", "### B\nGET {{host}}/b\n"),
            ("a/one.http", "### On disk\nGET {{host}}/disk\n"),
            ("node_modules/x.http", "GET {{host}}\n"),
        ]);
        let root = dir.path();
        let edited = crate::parse("### Edited\nGET https://x/{{host}}\n\n### Also\nGET {{host}}\n");
        let got: Vec<_> = usages(root, "host", &[(root.join("a/one.http"), edited)])
            .into_iter()
            .map(|u| match u {
                Usage::Request { path, name, .. } => (path.strip_prefix(root).unwrap().to_path_buf(), name),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            got,
            [
                ("a/one.http".into(), "Edited".to_string()),
                ("a/one.http".into(), "Also".to_string()),
                ("b.http".into(), "B".to_string())
            ]
        );
    }
}
