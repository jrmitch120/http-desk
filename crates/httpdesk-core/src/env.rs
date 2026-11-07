//! File-based environments following the JetBrains HTTP Client convention:
//! `http-client.env.json` (shareable) and `http-client.private.env.json`
//! (secrets, kept out of source control).
//!
//! ```json
//! { "$shared": { "version": "v1" }, "dev": { "baseUrl": "http://localhost:8080" } }
//! ```
//!
//! Non-scalar entries such as `SSLConfiguration` are preserved on save.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const ENV_FILE: &str = "http-client.env.json";
pub const PRIVATE_ENV_FILE: &str = "http-client.private.env.json";
pub const SHARED: &str = "$shared";

#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("could not read {path}: {source}")]
    Io { path: PathBuf, source: std::io::Error },
    #[error("{path} is not a valid environment file: {source}")]
    Json { path: PathBuf, source: serde_json::Error },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
    /// Stored in the private env file.
    pub secret: bool,
    /// JSON type the value was read with, so saving writes it back the same way.
    pub json_type: JsonType,
}

/// JSON type of an environment value. Values are edited as text; on save they are written
/// back with this type when the text still fits it (`"8080"` as a number, `""` as `null`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum JsonType {
    #[default]
    String,
    Number,
    Boolean,
    Null,
}

impl JsonType {
    fn of(v: &Value) -> Self {
        match v {
            Value::Number(_) => Self::Number,
            Value::Bool(_) => Self::Boolean,
            Value::Null => Self::Null,
            _ => Self::String,
        }
    }

    fn to_json(self, value: &str) -> Value {
        let typed = match self {
            Self::String => None,
            Self::Number => serde_json::from_str::<serde_json::Number>(value).ok().map(Value::Number),
            Self::Boolean => value.parse().ok().map(Value::Bool),
            Self::Null => value.is_empty().then_some(Value::Null),
        };
        typed.unwrap_or_else(|| Value::String(value.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Environment {
    pub name: String,
    pub variables: Vec<EnvVar>,
    /// The folders whose files supply it, when loaded (see [`load_for`]); ignored on save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<EnvSource>,
}

/// Which folders supply an environment (or `$shared`) to the requests of a folder
/// (ADR-0004): the nearest one whose public file defines it, and the nearest one whose
/// private file does. Relative to the root given to [`load_for`], `/`-separated, `""`
/// for the root itself. A variable's value comes from `private` when it's a Secret,
/// else from `public`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvSource {
    pub public: Option<String>,
    pub private: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvironmentSet {
    /// `$shared` variables, available in every environment.
    pub shared: Vec<EnvVar>,
    pub environments: Vec<Environment>,
    /// Whether the private env file is git-ignored; `None` when not in a git repository.
    pub private_file_ignored: Option<bool>,
    /// The folders supplying `$shared`, when loaded (see [`EnvSource`]); `None` when no file defines it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_source: Option<EnvSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub gitignore_updated: bool,
}

/// TLS settings from an environment's `SSLConfiguration` object (JetBrains).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SslConfig {
    pub client_certificate: Option<PathBuf>,
    pub client_certificate_key: Option<PathBuf>,
    pub verify_host_certificate: Option<bool>,
}

fn read_map(path: &Path) -> Result<Map<String, Value>, EnvError> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => serde_json::from_str(&text).map_err(|source| EnvError::Json { path: path.into(), source }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(source) => Err(EnvError::Io { path: path.into(), source }),
    }
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn upsert(vars: &mut Vec<EnvVar>, name: &str, value: String, json_type: JsonType, secret: bool) {
    match vars.iter_mut().find(|v| v.name == name) {
        Some(v) => {
            v.value = value;
            v.json_type = json_type;
            v.secret |= secret;
        }
        None => vars.push(EnvVar { name: name.into(), value, secret, json_type }),
    }
}

/// The environments in `dir`'s own pair of files (what the Environments modal edits).
pub fn load(dir: &Path) -> Result<EnvironmentSet, EnvError> {
    load_for(dir, dir)
}

/// The folders a request in `dir` looks in for env files, nearest first: `dir`, then each
/// parent up to and including `root`. A `dir` outside `root` looks only in `root`.
fn lookup_chain(root: &Path, dir: &Path) -> Vec<PathBuf> {
    if !dir.starts_with(root) {
        return vec![root.to_path_buf()];
    }
    dir.ancestors().take_while(|d| d.starts_with(root)).map(Path::to_path_buf).collect()
}

/// An environment (or `$shared`) as the nearest file of one kind defines it.
struct Definition<'a> {
    name: String,
    /// The folder of the file it comes from.
    dir: &'a Path,
    obj: Map<String, Value>,
}

/// For one kind of env file (public or private): each environment name (and `$shared`)
/// with what the nearest file along `chain` defines for it, in the order names first
/// appear reading from the farthest file (the root) down.
fn nearest_definitions<'a>(chain: &'a [PathBuf], file: &str) -> Result<Vec<Definition<'a>>, EnvError> {
    let maps = chain.iter().map(|d| Ok((d.as_path(), read_map(&d.join(file))?))).collect::<Result<Vec<_>, _>>()?;
    let mut found: Vec<Definition> = Vec::new();
    for (dir, map) in maps.into_iter().rev() {
        for (name, obj) in map {
            let Value::Object(obj) = obj else { continue };
            match found.iter_mut().find(|d| d.name == name) {
                // A nearer file defines it too: that file supplies the whole environment.
                Some(d) => (d.dir, d.obj) = (dir, obj),
                None => found.push(Definition { name, dir, obj }),
            }
        }
    }
    Ok(found)
}

/// The environments a request in folder `dir` (inside workspace `root`) is sent with
/// (ADR-0004). For each environment name, including `$shared`, the nearest folder whose
/// file defines it supplies it, looking in `dir` and then each parent up to `root`. Public
/// and private files are looked up separately; the private file's values override the
/// public file's (and are Secrets). Files of the same kind are never merged.
pub fn load_for(root: &Path, dir: &Path) -> Result<EnvironmentSet, EnvError> {
    let chain = lookup_chain(root, dir);
    let public = nearest_definitions(&chain, ENV_FILE)?;
    let private = nearest_definitions(&chain, PRIVATE_ENV_FILE)?;
    let mut set = EnvironmentSet { private_file_ignored: gitignore_status(&chain[0]), ..Default::default() };

    for (defs, secret) in [(&public, false), (&private, true)] {
        for Definition { name: env_name, obj, dir } in defs {
            let (vars, source) = if env_name == SHARED {
                (&mut set.shared, &mut set.shared_source)
            } else {
                if !set.environments.iter().any(|e| &e.name == env_name) {
                    set.environments.push(Environment { name: env_name.clone(), ..Default::default() });
                }
                let env = set.environments.iter_mut().find(|e| &e.name == env_name).unwrap();
                (&mut env.variables, &mut env.source)
            };
            let source = source.get_or_insert_with(EnvSource::default);
            let from = Some(relative_dir(root, dir));
            if secret {
                source.private = from;
            } else {
                source.public = from;
            }
            for (k, v) in obj {
                if let Some(value) = scalar(v) {
                    upsert(vars, k, value, JsonType::of(v), secret);
                }
            }
        }
    }
    Ok(set)
}

/// The environments of the requests in a folder below the workspace root that has env
/// files of its own (and in its subfolders that have none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderEnvironments {
    /// Relative to the workspace root, `/`-separated (`api/users`).
    pub dir: String,
    /// What [`load_for`] gives for the folder.
    pub set: EnvironmentSet,
}

/// [`FolderEnvironments`] for every folder below `root` with an env file, in explorer
/// order, skipping the folders the explorer skips. A request in a folder without an entry
/// uses its nearest parent's, or the root's own [`load`].
pub fn load_folders(root: &Path) -> Result<Vec<FolderEnvironments>, EnvError> {
    folders(root)?
        .into_iter()
        .map(|d| Ok(FolderEnvironments { dir: relative_dir(root, &d), set: load_for(root, &d)? }))
        .collect()
}

/// Every folder below `root` with an env file of its own, in explorer order, skipping
/// the folders the explorer skips.
pub fn folders(root: &Path) -> Result<Vec<PathBuf>, EnvError> {
    fn dirs(node: &crate::workspace::TreeNode, out: &mut Vec<PathBuf>) {
        for child in node.children.iter().flatten().filter(|c| c.kind == crate::workspace::NodeKind::Dir) {
            out.push(child.path.clone());
            dirs(child, out);
        }
    }
    let tree = crate::workspace::tree(root).map_err(|source| EnvError::Io { path: root.into(), source })?;
    let mut all = Vec::new();
    dirs(&tree, &mut all);
    all.retain(|d| d.join(ENV_FILE).is_file() || d.join(PRIVATE_ENV_FILE).is_file());
    Ok(all)
}

/// `dir` relative to `root`, `/`-separated (`api/users`; `""` for the root itself).
fn relative_dir(root: &Path, dir: &Path) -> String {
    let rel = dir.strip_prefix(root).unwrap_or(dir);
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Flattened variables for `env_name` (`$shared` first, then the environment).
pub fn variables(set: &EnvironmentSet, env_name: Option<&str>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = set.shared.iter().map(|v| (v.name.clone(), v.value.clone())).collect();
    if let Some(env) = env_name.and_then(|n| set.environments.iter().find(|e| e.name == n)) {
        out.extend(env.variables.iter().map(|v| (v.name.clone(), v.value.clone())));
    }
    out
}

/// The names [`variables`] gives a Secret's value for (an environment's own variable
/// replaces a same-named shared one, Secret or not).
pub fn secret_names(set: &EnvironmentSet, env_name: Option<&str>) -> HashSet<String> {
    let mut secret: HashMap<&str, bool> = set.shared.iter().map(|v| (v.name.as_str(), v.secret)).collect();
    if let Some(env) = env_name.and_then(|n| set.environments.iter().find(|e| e.name == n)) {
        secret.extend(env.variables.iter().map(|v| (v.name.as_str(), v.secret)));
    }
    secret.into_iter().filter(|(_, s)| *s).map(|(n, _)| n.to_string()).collect()
}

fn build_object(
    vars: &[EnvVar],
    old: Option<&Value>,
    write_secrets: bool,
    old_public: Option<&Value>,
) -> Map<String, Value> {
    let mut obj = Map::new();
    for v in vars.iter().filter(|v| !v.name.is_empty()) {
        if v.secret == write_secrets {
            obj.insert(v.name.clone(), v.json_type.to_json(&v.value));
        } else if !write_secrets {
            // A Secret already listed in the public file keeps an entry there, but only as an
            // empty placeholder (`null` stays `null`): never its value.
            if let Some(old) = old_public.and_then(|o| o.get(&v.name)).filter(|p| scalar(p).is_some()) {
                let placeholder = if old.is_null() { Value::Null } else { Value::String(String::new()) };
                obj.insert(v.name.clone(), placeholder);
            }
        }
    }
    if let Some(Value::Object(old)) = old {
        for (k, v) in old.iter().filter(|(_, v)| scalar(v).is_none()) {
            obj.insert(k.clone(), v.clone());
        }
    }
    obj
}

/// Saves `set` as `dir`'s own pair of files (`dir` being the workspace root).
pub fn save(dir: &Path, set: &EnvironmentSet) -> Result<SaveReport, EnvError> {
    save_folder(dir, dir, set)
}

/// Saves `set` as the own pair of files of folder `dir` in workspace `root`: Secrets
/// to the private file, the rest to the public one. Environments are listed in the
/// public file (so teammates see them) even when all their variables are Secrets,
/// except below the root when the public file doesn't list them yet: there an entry
/// would supply the whole environment and hide a farther folder's (ADR-0004).
pub fn save_folder(root: &Path, dir: &Path, set: &EnvironmentSet) -> Result<SaveReport, EnvError> {
    let public_path = dir.join(ENV_FILE);
    let private_path = dir.join(PRIVATE_ENV_FILE);
    let old_public = read_map(&public_path)?;
    let old_private = read_map(&private_path)?;

    let mut public = Map::new();
    let mut private = Map::new();
    let named =
        std::iter::once((SHARED, &set.shared)).chain(set.environments.iter().map(|e| (e.name.as_str(), &e.variables)));
    for (name, vars) in named {
        let pub_obj = build_object(vars, old_public.get(name), false, old_public.get(name));
        let priv_obj = build_object(vars, old_private.get(name), true, None);
        // `$shared` appears in the shareable file only when it has content or already existed.
        let listed = name != SHARED && (dir == root || priv_obj.is_empty());
        if listed || !pub_obj.is_empty() || old_public.contains_key(name) {
            public.insert(name.to_string(), Value::Object(pub_obj));
        }
        if !priv_obj.is_empty() {
            private.insert(name.to_string(), Value::Object(priv_obj));
        }
    }

    let write = |path: &Path, map: Map<String, Value>| -> Result<(), EnvError> {
        let text = serde_json::to_string_pretty(&Value::Object(map)).unwrap() + "\n";
        crate::workspace::write_atomic(path, text.as_bytes())
            .map_err(|source| EnvError::Io { path: path.into(), source })
    };

    if !public.is_empty() || public_path.exists() {
        write(&public_path, public)?;
    }
    let mut report = SaveReport::default();
    if !private.is_empty() || private_path.exists() {
        write(&private_path, private)?;
        report.gitignore_updated = ensure_gitignored(dir).unwrap_or(false);
    }
    Ok(report)
}

/// Adds variables that don't exist yet to `env_name` (creating it if needed).
/// Existing values are never overwritten.
pub fn merge_variables(
    dir: &Path,
    env_name: &str,
    vars: &[(String, String)],
    secret: bool,
) -> Result<SaveReport, EnvError> {
    let mut set = load(dir)?;
    if !set.environments.iter().any(|e| e.name == env_name) {
        set.environments.push(Environment { name: env_name.to_string(), ..Default::default() });
    }
    let env = set.environments.iter_mut().find(|e| e.name == env_name).unwrap();
    for (k, v) in vars {
        if !env.variables.iter().any(|e| &e.name == k) {
            env.variables.push(EnvVar { name: k.clone(), value: v.clone(), secret, ..Default::default() });
        }
    }
    save(dir, &set)
}

/// What the repository's `.gitignore` rules say about the private env file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitignoreRule {
    /// A rule ignores it (or a folder it is in).
    Ignored,
    /// A `!` rule un-ignores it: the user wants it tracked.
    Negated,
    /// No rule matches it.
    Unmatched,
}

/// The rule that decides whether git ignores the private env file in `dir`, judged by the
/// `.gitignore` files from the nearest enclosing repository root (a `.git` dir or file) down
/// to `dir`. `None` when `dir` isn't inside a git repository. Local-only rules
/// (`.git/info/exclude`, global excludes) don't count, since they don't protect teammates' clones.
fn gitignore_rule(dir: &Path) -> Option<GitignoreRule> {
    use ignore::gitignore::Gitignore;
    use ignore::Match;

    let root = dir.ancestors().find(|d| d.join(".git").exists())?;
    // Deepest first: a deeper `.gitignore` overrides a shallower one.
    let rules: Vec<Gitignore> =
        dir.ancestors().take_while(|d| d.starts_with(root)).map(|d| Gitignore::new(d.join(".gitignore")).0).collect();
    let file = dir.join(PRIVATE_ENV_FILE);
    let parts: Vec<_> = file.strip_prefix(root).ok()?.components().collect();
    // Like git, walk down from the root: once a folder is ignored, everything in it is.
    let mut path = root.to_path_buf();
    let mut rule = GitignoreRule::Unmatched;
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        let parent = path.parent()?;
        let verdict = rules
            .iter()
            .filter(|g| parent.starts_with(g.path()))
            .map(|g| g.matched(&path, i + 1 < parts.len()))
            .find(|m| !m.is_none());
        match verdict {
            Some(Match::Ignore(_)) => return Some(GitignoreRule::Ignored),
            Some(Match::Whitelist(_)) if i + 1 == parts.len() => rule = GitignoreRule::Negated,
            _ => {}
        }
    }
    Some(rule)
}

/// Whether git ignores the private env file in `dir`; `None` outside a git repository.
fn gitignore_status(dir: &Path) -> Option<bool> {
    gitignore_rule(dir).map(|r| r == GitignoreRule::Ignored)
}

/// Makes sure git ignores the private env file, if there is one in `dir`: when `dir` is
/// inside a git repository and no rule matches the file at all, appends it to
/// `dir/.gitignore`. An explicit `!` negation is the user's choice and is left alone (the
/// Environments editor still warns). Returns whether `.gitignore` changed.
pub fn ensure_gitignored(dir: &Path) -> std::io::Result<bool> {
    if !dir.join(PRIVATE_ENV_FILE).exists() || gitignore_rule(dir) != Some(GitignoreRule::Unmatched) {
        return Ok(false);
    }
    let path = dir.join(".gitignore");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("# HttpDesk: secrets\n{PRIVATE_ENV_FILE}\n"));
    std::fs::write(path, text)?;
    Ok(true)
}

/// Reads `SSLConfiguration` for an environment of a request in folder `dir`, from the
/// files that supply the environment (see [`load_for`]; private overrides public).
/// Relative paths start from the folder of the file that holds them.
pub fn ssl_config(root: &Path, dir: &Path, env_name: &str) -> SslConfig {
    let mut cfg = SslConfig::default();
    let chain = lookup_chain(root, dir);
    for file in [ENV_FILE, PRIVATE_ENV_FILE] {
        let Ok(defs) = nearest_definitions(&chain, file) else { continue };
        let Some(def) = defs.into_iter().find(|d| d.name == env_name) else { continue };
        let Some(ssl) = def.obj.get("SSLConfiguration") else { continue };
        let path = |key: &str| ssl.get(key).and_then(Value::as_str).map(|p| def.dir.join(p));
        if let Some(p) = path("clientCertificate") {
            cfg.client_certificate = Some(p);
        }
        if let Some(p) = path("clientCertificateKey") {
            cfg.client_certificate_key = Some(p);
        }
        if let Some(v) = ssl.get("verifyHostCertificate").and_then(Value::as_bool) {
            cfg.verify_host_certificate = Some(v);
        }
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_merges_private_and_preserves_ssl_on_save() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(
            dir.path().join(ENV_FILE),
            r#"{ "$shared": {"v": "1"}, "dev": { "baseUrl": "http://localhost", "token": "", "port": 8080, "SSLConfiguration": { "verifyHostCertificate": false } } }"#,
        )
        .unwrap();
        let set = load(dir.path()).unwrap();
        assert_eq!(set.private_file_ignored, Some(false));
        assert_eq!(set.environments[0].variables.len(), 3);

        let mut set = set;
        let token = set.environments[0].variables.iter_mut().find(|v| v.name == "token").unwrap();
        token.value = "s3cret".into();
        token.secret = true;
        set.environments.push(Environment {
            name: "prod".into(),
            variables: vec![EnvVar { name: "baseUrl".into(), value: "https://api".into(), ..Default::default() }],
            ..Default::default()
        });
        let report = save(dir.path(), &set).unwrap();
        assert!(report.gitignore_updated);

        let public = std::fs::read_to_string(dir.path().join(ENV_FILE)).unwrap();
        let private = std::fs::read_to_string(dir.path().join(PRIVATE_ENV_FILE)).unwrap();
        assert!(!public.contains("s3cret"));
        assert!(public.contains("\"token\": \"\""), "placeholder kept: {public}");
        assert!(public.contains("SSLConfiguration"));
        assert!(private.contains("s3cret"));
        assert!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap().contains(PRIVATE_ENV_FILE));

        let again = load(dir.path()).unwrap();
        assert_eq!(again.private_file_ignored, Some(true));
        let vars = variables(&again, Some("dev"));
        assert_eq!(vars["token"], "s3cret");
        assert_eq!(vars["v"], "1");
        assert_eq!(vars["port"], "8080");
        assert_eq!(ssl_config(dir.path(), dir.path(), "dev").verify_host_certificate, Some(false));
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn ticking_secret_moves_the_value_out_of_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ENV_FILE), r#"{ "dev": { "baseUrl": "http://localhost", "token": "s3cret" } }"#)
            .unwrap();
        let mut set = load(dir.path()).unwrap();
        set.environments[0].variables.iter_mut().find(|v| v.name == "token").unwrap().secret = true;
        save(dir.path(), &set).unwrap();

        assert_eq!(
            read_json(&dir.path().join(ENV_FILE)),
            serde_json::json!({ "dev": { "baseUrl": "http://localhost", "token": "" } })
        );
        assert_eq!(read_json(&dir.path().join(PRIVATE_ENV_FILE)), serde_json::json!({ "dev": { "token": "s3cret" } }));
        assert_eq!(variables(&load(dir.path()).unwrap(), Some("dev"))["token"], "s3cret");
    }

    #[test]
    fn numbers_booleans_and_null_keep_their_json_types() {
        let dir = tempfile::tempdir().unwrap();
        let original = serde_json::json!({ "dev": { "port": 8080, "ratio": 1.5, "debug": true, "proxy": null, "name": "api", "code": "007" } });
        std::fs::write(dir.path().join(ENV_FILE), original.to_string()).unwrap();

        save(dir.path(), &load(dir.path()).unwrap()).unwrap();
        assert_eq!(read_json(&dir.path().join(ENV_FILE)), original);

        // Edited values keep their type when they still fit it; a Secret keeps it in the private file.
        let mut set = load(dir.path()).unwrap();
        let vars = &mut set.environments[0].variables;
        let var = |vars: &mut Vec<EnvVar>, name: &str| vars.iter_mut().position(|v| v.name == name).unwrap();
        let i = var(vars, "port");
        vars[i].value = "9090".into();
        vars[i].secret = true;
        let i = var(vars, "debug");
        vars[i].value = "false".into();
        let i = var(vars, "ratio");
        vars[i].value = "lots".into();
        save(dir.path(), &set).unwrap();
        assert_eq!(
            read_json(&dir.path().join(ENV_FILE)),
            serde_json::json!({ "dev": { "port": "", "ratio": "lots", "debug": false, "proxy": null, "name": "api", "code": "007" } })
        );
        assert_eq!(read_json(&dir.path().join(PRIVATE_ENV_FILE)), serde_json::json!({ "dev": { "port": 9090 } }));
    }

    /// A git repo with the workspace in `api/`, holding a private env file.
    fn repo_with_workspace_subfolder() -> (tempfile::TempDir, PathBuf) {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join(".git")).unwrap();
        let ws = repo.path().join("api");
        std::fs::create_dir(&ws).unwrap();
        std::fs::write(ws.join(PRIVATE_ENV_FILE), r#"{ "dev": { "token": "s3cret" } }"#).unwrap();
        (repo, ws)
    }

    #[test]
    fn private_file_in_a_repo_subfolder_gets_gitignored() {
        let (repo, ws) = repo_with_workspace_subfolder();
        // A root-anchored rule only covers the repo root, not this folder.
        std::fs::write(repo.path().join(".gitignore"), "/http-client.private.env.json\n").unwrap();
        assert_eq!(load(&ws).unwrap().private_file_ignored, Some(false));

        assert!(ensure_gitignored(&ws).unwrap());
        assert_eq!(
            std::fs::read_to_string(ws.join(".gitignore")).unwrap(),
            format!("# HttpDesk: secrets\n{PRIVATE_ENV_FILE}\n")
        );
        assert_eq!(load(&ws).unwrap().private_file_ignored, Some(true));
        assert!(!ensure_gitignored(&ws).unwrap(), "second call changes nothing");
    }

    #[test]
    fn existing_repo_rules_that_ignore_the_private_file_are_respected() {
        for rule in ["*.private.env.json", "api/", "/api/http-client.private.env.json", "**/http-client.*.env.json"] {
            let (repo, ws) = repo_with_workspace_subfolder();
            std::fs::write(repo.path().join(".gitignore"), format!("{rule}\n")).unwrap();
            assert_eq!(load(&ws).unwrap().private_file_ignored, Some(true), "{rule}");
            assert!(!ensure_gitignored(&ws).unwrap(), "{rule}");
            assert!(!ws.join(".gitignore").exists(), "{rule}");
        }
        // A deeper negation un-ignores it again.
        let (repo, ws) = repo_with_workspace_subfolder();
        std::fs::write(repo.path().join(".gitignore"), "*.private.env.json\n").unwrap();
        std::fs::write(ws.join(".gitignore"), format!("!{PRIVATE_ENV_FILE}\n")).unwrap();
        assert_eq!(load(&ws).unwrap().private_file_ignored, Some(false));
    }

    #[test]
    fn an_explicit_negation_is_the_users_choice() {
        let (repo, ws) = repo_with_workspace_subfolder();
        let negation = format!("*.private.env.json\n!{PRIVATE_ENV_FILE}\n");
        std::fs::write(repo.path().join(".gitignore"), &negation).unwrap();

        assert!(!ensure_gitignored(&ws).unwrap(), "nothing appended");
        let mut set = load(&ws).unwrap();
        assert_eq!(set.private_file_ignored, Some(false), "the Environments warning still shows");
        set.environments[0].variables[0].value = "n3w".into();
        let report = save(&ws, &set).unwrap();
        assert!(!report.gitignore_updated, "saving environments doesn't re-append it either");
        assert!(!ws.join(".gitignore").exists());
        assert_eq!(std::fs::read_to_string(repo.path().join(".gitignore")).unwrap(), negation);
    }

    #[test]
    fn gitignore_is_left_alone_without_a_private_file_or_a_repo() {
        let (_repo, ws) = repo_with_workspace_subfolder();
        std::fs::remove_file(ws.join(PRIVATE_ENV_FILE)).unwrap();
        assert!(!ensure_gitignored(&ws).unwrap());
        assert!(!ws.join(".gitignore").exists());

        let plain = tempfile::tempdir().unwrap();
        std::fs::write(plain.path().join(PRIVATE_ENV_FILE), "{}").unwrap();
        assert_eq!(load(plain.path()).unwrap().private_file_ignored, None);
        assert!(!ensure_gitignored(plain.path()).unwrap());
    }

    #[test]
    fn secret_names_are_those_whose_value_in_use_is_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(ENV_FILE),
            r#"{ "$shared": { "key": "", "plain": "p" }, "dev": { "key": "public", "url": "u" } }"#,
        )
        .unwrap();
        std::fs::write(dir.path().join(PRIVATE_ENV_FILE), r#"{ "$shared": { "key": "k" }, "dev": { "token": "t" } }"#)
            .unwrap();
        let set = load(dir.path()).unwrap();
        let mut dev: Vec<_> = secret_names(&set, Some("dev")).into_iter().collect();
        dev.sort();
        assert_eq!(dev, ["token"], "dev's shareable key is in use over the shared Secret");
        assert_eq!(secret_names(&set, None).into_iter().collect::<Vec<_>>(), ["key"]);
    }

    #[test]
    fn merge_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        merge_variables(dir.path(), "dev", &[("a".into(), "1".into())], false).unwrap();
        merge_variables(dir.path(), "dev", &[("a".into(), "2".into()), ("b".into(), "3".into())], false).unwrap();
        merge_variables(dir.path(), "dev", &[("token".into(), String::new())], true).unwrap();
        let set = load(dir.path()).unwrap();
        let vars = variables(&set, Some("dev"));
        assert_eq!((vars["a"].as_str(), vars["b"].as_str()), ("1", "3"));
        assert!(set.environments[0].variables.iter().find(|v| v.name == "token").unwrap().secret);
        assert!(dir.path().join(PRIVATE_ENV_FILE).exists());
        assert_eq!(set.private_file_ignored, None, "not a git repo, gitignore untouched");
    }

    /// Writes env file `file` (public or private) with `json` in folder `rel` under `root`.
    fn write_env(root: &Path, rel: &str, file: &str, json: Value) {
        let dir = root.join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), json.to_string()).unwrap();
    }

    fn env_vars(set: &EnvironmentSet, env: &str) -> Vec<(String, String)> {
        let mut vars: Vec<_> = variables(set, Some(env)).into_iter().collect();
        vars.sort();
        vars
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_nearest_folder_defining_an_environment_supplies_all_of_it() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(
            root,
            "",
            ENV_FILE,
            serde_json::json!({ "dev": { "host": "root.dev", "port": "1" }, "prod": { "host": "root.prod" } }),
        );
        write_env(root, "api", ENV_FILE, serde_json::json!({ "dev": { "host": "api.dev" } }));

        let set = load_for(root, &root.join("api/users")).unwrap();
        // No merging with the root's `dev`: its `port` doesn't leak in.
        assert_eq!(env_vars(&set, "dev"), pairs(&[("host", "api.dev")]));
        // An environment only the root defines still comes from the root.
        assert_eq!(env_vars(&set, "prod"), pairs(&[("host", "root.prod")]));
        assert_eq!(env_vars(&load_for(root, root).unwrap(), "dev"), pairs(&[("host", "root.dev"), ("port", "1")]));
    }

    #[test]
    fn public_and_private_files_are_looked_up_separately_and_private_wins() {
        // The JetBrains docs' example: the root's public `host` with service1's private `key`.
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "dev": { "host": "root.dev", "key": "" } }));
        write_env(root, "", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "key": "root-key", "other": "x" } }));
        write_env(root, "service1", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "key": "s1-key" } }));

        let set = load_for(root, &root.join("service1")).unwrap();
        assert_eq!(env_vars(&set, "dev"), pairs(&[("host", "root.dev"), ("key", "s1-key")]));
        let dev = &set.environments[0].variables;
        assert!(dev.iter().find(|v| v.name == "key").unwrap().secret);
        assert!(!dev.iter().find(|v| v.name == "host").unwrap().secret);
    }

    #[test]
    fn each_environment_says_which_folders_supply_its_public_and_private_values() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "$shared": { "v": "1" }, "dev": { "host": "h" }, "qa": {} }));
        write_env(root, "", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "key": "root-key" } }));
        write_env(root, "api", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "key": "api-key" } }));
        write_env(root, "api/users", ENV_FILE, serde_json::json!({ "qa": { "host": "users.qa" } }));

        let set = load_for(root, &root.join("api/users")).unwrap();
        let source = |public: Option<&str>, private: Option<&str>| {
            Some(EnvSource { public: public.map(String::from), private: private.map(String::from) })
        };
        let env = |name: &str| set.environments.iter().find(|e| e.name == name).unwrap().source.clone();
        assert_eq!(env("dev"), source(Some(""), Some("api")));
        assert_eq!(env("qa"), source(Some("api/users"), None));
        assert_eq!(set.shared_source, source(Some(""), None));
        // A folder's own pair names itself.
        assert_eq!(load(&root.join("api")).unwrap().environments[0].source, source(None, Some("")));
    }

    #[test]
    fn saving_a_folders_secrets_doesnt_hide_a_farther_folders_public_environment() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "dev": { "host": "root.dev" } }));
        write_env(root, "api", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "key": "old" } }));
        let api = root.join("api");

        let mut set = load(&api).unwrap();
        set.environments[0].variables[0].value = "new".into();
        set.environments.push(Environment { name: "qa".into(), ..Default::default() });
        save_folder(root, &api, &set).unwrap();

        // An `"dev": {}` in api's public file would supply all of dev and lose the root's host.
        assert_eq!(read_json(&api.join(ENV_FILE)), serde_json::json!({ "qa": {} }));
        assert_eq!(env_vars(&load_for(root, &api).unwrap(), "dev"), pairs(&[("host", "root.dev"), ("key", "new")]));
        // At the root nothing is farther, so every environment is listed in the shareable file.
        save_folder(root, root, &load(&api).unwrap()).unwrap();
        assert_eq!(read_json(&root.join(ENV_FILE)), serde_json::json!({ "dev": {}, "qa": {} }));
    }

    #[test]
    fn shared_variables_follow_the_same_nearest_wins_rule() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "$shared": { "version": "v1", "region": "eu" } }));
        write_env(root, "api", ENV_FILE, serde_json::json!({ "$shared": { "version": "v2" } }));

        assert_eq!(env_vars(&load_for(root, &root.join("api")).unwrap(), "dev"), pairs(&[("version", "v2")]));
        assert_eq!(
            env_vars(&load_for(root, &root.join("web")).unwrap(), "dev"),
            pairs(&[("region", "eu"), ("version", "v1")])
        );
    }

    #[test]
    fn the_lookup_stops_at_the_workspace_root() {
        let outer = tempfile::tempdir().unwrap();
        write_env(
            outer.path(),
            "",
            ENV_FILE,
            serde_json::json!({ "dev": { "host": "outside" }, "$shared": { "v": "1" } }),
        );
        let root = outer.path().join("workspace");
        write_env(&root, "api", ENV_FILE, serde_json::json!({ "prod": { "host": "api.prod" } }));

        let set = load_for(&root, &root.join("api")).unwrap();
        assert_eq!(set.environments.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["prod"]);
        assert!(set.shared.is_empty());
    }

    #[test]
    fn an_environment_no_folder_in_the_chain_defines_gives_no_environment() {
        // `staging` exists only in a sibling folder: it's never borrowed.
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "$shared": { "v": "1" }, "dev": { "host": "root.dev" } }));
        write_env(root, "billing", ENV_FILE, serde_json::json!({ "staging": { "host": "billing.staging" } }));

        let set = load_for(root, &root.join("users")).unwrap();
        assert!(!set.environments.iter().any(|e| e.name == "staging"));
        assert_eq!(env_vars(&set, "staging"), pairs(&[("v", "1")]), "like No environment: only $shared");
    }

    #[test]
    fn every_folder_below_the_root_with_env_files_gets_its_requests_environments() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        write_env(root, "", ENV_FILE, serde_json::json!({ "dev": { "host": "root.dev" } }));
        write_env(root, "api", ENV_FILE, serde_json::json!({ "dev": { "host": "api.dev" } }));
        write_env(root, "api/users", PRIVATE_ENV_FILE, serde_json::json!({ "dev": { "token": "t" } }));
        write_env(root, "web", ENV_FILE, serde_json::json!({ "qa": { "host": "web.qa" } }));
        // Folders the explorer skips are skipped here too.
        write_env(root, "node_modules/pkg", ENV_FILE, serde_json::json!({ "dev": {} }));
        write_env(root, ".idea", ENV_FILE, serde_json::json!({ "dev": {} }));
        std::fs::create_dir_all(root.join("docs")).unwrap();

        let folders = load_folders(root).unwrap();
        let dirs: Vec<_> = folders.iter().map(|f| f.dir.as_str()).collect();
        assert_eq!(dirs, ["api", "api/users", "web"]);
        assert_eq!(env_vars(&folders[1].set, "dev"), pairs(&[("host", "api.dev"), ("token", "t")]));
        assert_eq!(folders[2].set, load_for(root, &root.join("web")).unwrap());
    }

    #[test]
    fn ssl_configuration_comes_from_the_files_that_supply_the_environment() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let ssl = |cert: &str| serde_json::json!({ "SSLConfiguration": { "clientCertificate": cert, "verifyHostCertificate": false } });
        write_env(root, "", ENV_FILE, serde_json::json!({ "dev": ssl("root.pem"), "prod": ssl("prod.pem") }));
        write_env(root, "api", ENV_FILE, serde_json::json!({ "dev": ssl("api.pem") }));
        write_env(
            root,
            "api",
            PRIVATE_ENV_FILE,
            serde_json::json!({ "prod": { "SSLConfiguration": { "clientCertificateKey": "k.pem" } } }),
        );

        let api = root.join("api/users");
        let dev = ssl_config(root, &api, "dev");
        assert_eq!(dev.client_certificate, Some(root.join("api").join("api.pem")));
        assert_eq!(dev.verify_host_certificate, Some(false));
        let prod = ssl_config(root, &api, "prod");
        assert_eq!(prod.client_certificate, Some(root.join("prod.pem")));
        assert_eq!(prod.client_certificate_key, Some(root.join("api").join("k.pem")));
        assert_eq!(ssl_config(root, &api, "qa"), SslConfig::default());
    }
}
