//! File-based environments following the JetBrains HTTP Client convention:
//! `http-client.env.json` (shareable) and `http-client.private.env.json`
//! (secrets, kept out of source control).
//!
//! ```json
//! { "$shared": { "version": "v1" }, "dev": { "baseUrl": "http://localhost:8080" } }
//! ```
//!
//! Non-scalar entries such as `SSLConfiguration` are preserved on save.

use std::collections::HashMap;
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvironmentSet {
    /// `$shared` variables, available in every environment.
    pub shared: Vec<EnvVar>,
    pub environments: Vec<Environment>,
    /// Whether the private env file is git-ignored; `None` when not in a git repository.
    pub private_file_ignored: Option<bool>,
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

pub fn load(dir: &Path) -> Result<EnvironmentSet, EnvError> {
    let public = read_map(&dir.join(ENV_FILE))?;
    let private = read_map(&dir.join(PRIVATE_ENV_FILE))?;
    let mut set = EnvironmentSet { private_file_ignored: gitignore_status(dir), ..Default::default() };

    for (map, secret) in [(&public, false), (&private, true)] {
        for (env_name, obj) in map {
            let Some(obj) = obj.as_object() else { continue };
            let vars = if env_name == SHARED {
                &mut set.shared
            } else {
                if !set.environments.iter().any(|e| &e.name == env_name) {
                    set.environments.push(Environment { name: env_name.clone(), variables: vec![] });
                }
                &mut set.environments.iter_mut().find(|e| &e.name == env_name).unwrap().variables
            };
            for (k, v) in obj {
                if let Some(value) = scalar(v) {
                    upsert(vars, k, value, JsonType::of(v), secret);
                }
            }
        }
    }
    Ok(set)
}

/// Flattened variables for `env_name` (`$shared` first, then the environment).
pub fn variables(set: &EnvironmentSet, env_name: Option<&str>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = set.shared.iter().map(|v| (v.name.clone(), v.value.clone())).collect();
    if let Some(env) = env_name.and_then(|n| set.environments.iter().find(|e| e.name == n)) {
        out.extend(env.variables.iter().map(|v| (v.name.clone(), v.value.clone())));
    }
    out
}

fn build_object(vars: &[EnvVar], old: Option<&Value>, write_secrets: bool, old_public: Option<&Value>) -> Map<String, Value> {
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

pub fn save(dir: &Path, set: &EnvironmentSet) -> Result<SaveReport, EnvError> {
    let public_path = dir.join(ENV_FILE);
    let private_path = dir.join(PRIVATE_ENV_FILE);
    let old_public = read_map(&public_path)?;
    let old_private = read_map(&private_path)?;

    let mut public = Map::new();
    let mut private = Map::new();
    let named = std::iter::once((SHARED, &set.shared)).chain(set.environments.iter().map(|e| (e.name.as_str(), &e.variables)));
    for (name, vars) in named {
        let pub_obj = build_object(vars, old_public.get(name), false, old_public.get(name));
        let priv_obj = build_object(vars, old_private.get(name), true, None);
        // Environments always appear in the shareable file (so teammates see them),
        // `$shared` only when it has content or already existed.
        if name != SHARED || !pub_obj.is_empty() || old_public.contains_key(SHARED) {
            public.insert(name.to_string(), Value::Object(pub_obj));
        }
        if !priv_obj.is_empty() {
            private.insert(name.to_string(), Value::Object(priv_obj));
        }
    }

    let write = |path: &Path, map: Map<String, Value>| -> Result<(), EnvError> {
        let text = serde_json::to_string_pretty(&Value::Object(map)).unwrap() + "\n";
        crate::workspace::write_atomic(path, text.as_bytes()).map_err(|source| EnvError::Io { path: path.into(), source })
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
pub fn merge_variables(dir: &Path, env_name: &str, vars: &[(String, String)], secret: bool) -> Result<SaveReport, EnvError> {
    let mut set = load(dir)?;
    if !set.environments.iter().any(|e| e.name == env_name) {
        set.environments.push(Environment { name: env_name.to_string(), variables: vec![] });
    }
    let env = set.environments.iter_mut().find(|e| e.name == env_name).unwrap();
    for (k, v) in vars {
        if !env.variables.iter().any(|e| &e.name == k) {
            env.variables.push(EnvVar { name: k.clone(), value: v.clone(), secret, ..Default::default() });
        }
    }
    save(dir, &set)
}

/// Whether git ignores the private env file in `dir`, judged by the `.gitignore` files from
/// the nearest enclosing repository root (a `.git` dir or file) down to `dir`. `None` when
/// `dir` isn't inside a git repository. Local-only rules (`.git/info/exclude`, global
/// excludes) don't count, since they don't protect teammates' clones.
fn gitignore_status(dir: &Path) -> Option<bool> {
    use ignore::gitignore::Gitignore;
    use ignore::Match;

    let root = dir.ancestors().find(|d| d.join(".git").exists())?;
    // Deepest first: a deeper `.gitignore` overrides a shallower one.
    let rules: Vec<Gitignore> = dir.ancestors().take_while(|d| d.starts_with(root)).map(|d| Gitignore::new(d.join(".gitignore")).0).collect();
    let file = dir.join(PRIVATE_ENV_FILE);
    let parts: Vec<_> = file.strip_prefix(root).ok()?.components().collect();
    // Like git, walk down from the root: once a folder is ignored, everything in it is.
    let mut path = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        let parent = path.parent()?;
        let verdict = rules
            .iter()
            .filter(|g| parent.starts_with(g.path()))
            .map(|g| g.matched(&path, i + 1 < parts.len()))
            .find(|m| !m.is_none());
        if let Some(Match::Ignore(_)) = verdict {
            return Some(true);
        }
    }
    Some(false)
}

/// Makes sure git ignores the private env file, if there is one in `dir`: when `dir` is
/// inside a git repository and no existing rule ignores it, appends it to `dir/.gitignore`.
/// Returns whether `.gitignore` changed.
pub fn ensure_gitignored(dir: &Path) -> std::io::Result<bool> {
    if !dir.join(PRIVATE_ENV_FILE).exists() || gitignore_status(dir) != Some(false) {
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

/// Reads `SSLConfiguration` for an environment (private file overrides public).
pub fn ssl_config(dir: &Path, env_name: &str) -> SslConfig {
    let mut cfg = SslConfig::default();
    for file in [ENV_FILE, PRIVATE_ENV_FILE] {
        let Ok(map) = read_map(&dir.join(file)) else { continue };
        let Some(ssl) = map.get(env_name).and_then(|e| e.get("SSLConfiguration")) else { continue };
        let path = |key: &str| ssl.get(key).and_then(Value::as_str).map(|p| dir.join(p));
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
        set.environments.push(Environment { name: "prod".into(), variables: vec![EnvVar { name: "baseUrl".into(), value: "https://api".into(), ..Default::default() }] });
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
        assert_eq!(ssl_config(dir.path(), "dev").verify_host_certificate, Some(false));
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn ticking_secret_moves_the_value_out_of_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ENV_FILE), r#"{ "dev": { "baseUrl": "http://localhost", "token": "s3cret" } }"#).unwrap();
        let mut set = load(dir.path()).unwrap();
        set.environments[0].variables.iter_mut().find(|v| v.name == "token").unwrap().secret = true;
        save(dir.path(), &set).unwrap();

        assert_eq!(read_json(&dir.path().join(ENV_FILE)), serde_json::json!({ "dev": { "baseUrl": "http://localhost", "token": "" } }));
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
        assert_eq!(std::fs::read_to_string(ws.join(".gitignore")).unwrap(), format!("# HttpDesk: secrets\n{PRIVATE_ENV_FILE}\n"));
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
}
