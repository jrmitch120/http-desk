//! OpenAPI 3.0 / 3.1 loading, validation and `.http` generation.
//!
//! Specs are processed structurally as `serde_json::Value` (YAML is converted),
//! so both 3.0 and 3.1 go through one tolerant code path. Local `$ref`s are
//! resolved lazily with cycle detection; relative-file external refs are
//! inlined at load time. See `docs/ARCHITECTURE.md` §6.

mod example;
mod generate;
mod refs;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::HttpFile;

pub use generate::HTTP_METHODS;

#[derive(Debug, thiserror::Error)]
pub enum OpenApiError {
    #[error("Could not parse the specification: {0}")]
    Parse(String),
    #[error("Not an OpenAPI 3 document: {0}")]
    NotOpenApi(String),
    #[error("Unsupported specification: {0}")]
    Unsupported(String),
    #[error("Invalid OpenAPI document: {0}")]
    Invalid(String),
    #[error("Could not read the specification: {0}")]
    Io(String),
    #[error("Could not download the specification: {0}")]
    Http(String),
}

impl Serialize for OpenApiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecSummary {
    pub title: String,
    pub version: String,
    pub openapi_version: String,
    pub description: Option<String>,
    pub servers: Vec<ServerInfo>,
    pub operations: Vec<OperationInfo>,
    pub tags: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// Server URL with server variables replaced by their defaults.
    pub url: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationInfo {
    /// Stable key: `operationId`, or `METHOD path` when absent or duplicated.
    pub id: String,
    pub method: String,
    pub path: String,
    pub summary: Option<String>,
    pub operation_id: Option<String>,
    pub tags: Vec<String>,
    pub deprecated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Grouping {
    #[default]
    Tag,
    Path,
    Single,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenerateOptions {
    /// Operation ids (`OperationInfo::id`) to generate; empty means all.
    pub operation_ids: Vec<String>,
    pub grouping: Grouping,
    pub base_url_variable: String,
    pub single_file_name: Option<String>,
    /// Write parameter descriptions as `# @param` / `# @header` lines.
    pub param_descriptions: bool,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        GenerateOptions {
            operation_ids: Vec::new(),
            grouping: Grouping::Tag,
            base_url_variable: "baseUrl".into(),
            single_file_name: None,
            param_descriptions: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub relative_path: String,
    pub file: HttpFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedEnvironment {
    pub name: String,
    pub variables: Vec<(String, String)>,
    /// Credential variables (empty values) destined for the private env file.
    pub secrets: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationOutput {
    pub files: Vec<GeneratedFile>,
    pub environments: Vec<GeneratedEnvironment>,
    pub warnings: Vec<String>,
}

/// A loaded, validated OpenAPI document.
#[derive(Debug, Clone)]
pub struct OpenApiDoc {
    root: Value,
    source_url: Option<String>,
    warnings: Vec<String>,
}

impl OpenApiDoc {
    /// Parses a YAML or JSON spec. Relative-file `$ref`s are resolved against
    /// `base_dir` when given.
    pub fn parse(text: &str, base_dir: Option<&Path>) -> Result<OpenApiDoc, OpenApiError> {
        let mut root = parse_value(text).map_err(OpenApiError::Parse)?;
        let mut warnings = validate(&root)?;
        refs::bundle_external(&mut root, base_dir.map(Path::to_path_buf), &mut warnings);
        Ok(OpenApiDoc { root, source_url: None, warnings })
    }

    pub fn load_file(path: &Path) -> Result<OpenApiDoc, OpenApiError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| OpenApiError::Io(format!("{}: {e}", path.display())))?;
        let dir: PathBuf = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Self::parse(&text, Some(&dir))
    }

    pub async fn load_url(url: &str) -> Result<OpenApiDoc, OpenApiError> {
        // Some servers (e.g. api.weather.gov) reject requests without a User-Agent.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent(concat!("HttpDesk/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| OpenApiError::Http(e.to_string()))?;
        let resp = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json, application/yaml, application/x-yaml, text/yaml, */*;q=0.8")
            .send()
            .await
            .map_err(|e| OpenApiError::Http(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(OpenApiError::Http(format!("{url} returned HTTP {status}")));
        }
        let text = resp.text().await.map_err(|e| OpenApiError::Http(e.to_string()))?;
        let mut doc = Self::parse(&text, None)?;
        doc.source_url = Some(url.to_string());
        Ok(doc)
    }

    /// The resolved document (external refs inlined, local refs intact).
    pub fn value(&self) -> &Value {
        &self.root
    }

    pub fn summary(&self) -> SpecSummary {
        let info = self.root.get("info");
        let s = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
        let operations: Vec<OperationInfo> =
            generate::collect_operations(&self.root).into_iter().map(|o| o.info).collect();
        let mut tags: Vec<String> = self
            .root
            .get("tags")
            .and_then(Value::as_array)
            .map(|t| t.iter().filter_map(|t| s(t.get("name"))).collect())
            .unwrap_or_default();
        for op in &operations {
            for t in &op.tags {
                if !tags.contains(t) {
                    tags.push(t.clone());
                }
            }
        }
        tags.retain(|t| operations.iter().any(|o| o.tags.contains(t)));
        SpecSummary {
            title: s(info.and_then(|i| i.get("title"))).unwrap_or_else(|| "Untitled API".into()),
            version: s(info.and_then(|i| i.get("version"))).unwrap_or_default(),
            openapi_version: s(self.root.get("openapi")).unwrap_or_default(),
            description: s(info.and_then(|i| i.get("description"))),
            servers: self.servers(),
            operations,
            tags,
            warnings: self.warnings.clone(),
        }
    }

    pub fn servers(&self) -> Vec<ServerInfo> {
        let mut out = Vec::new();
        for srv in self.root.get("servers").and_then(Value::as_array).into_iter().flatten() {
            let Some(raw) = srv.get("url").and_then(Value::as_str) else { continue };
            let mut url = raw.to_string();
            if let Some(vars) = srv.get("variables").and_then(Value::as_object) {
                for (name, var) in vars {
                    let default = var
                        .get("default")
                        .and_then(Value::as_str)
                        .or_else(|| var.get("enum").and_then(|e| e.get(0)).and_then(Value::as_str))
                        .unwrap_or("");
                    url = url.replace(&format!("{{{name}}}"), default);
                }
            }
            out.push(ServerInfo {
                url: self.absolutize(&url),
                description: srv.get("description").and_then(Value::as_str).map(str::to_string),
            });
        }
        out
    }

    /// Resolves relative server URLs against the spec URL (or localhost).
    fn absolutize(&self, url: &str) -> String {
        if url.contains("://") {
            return url.trim_end_matches('/').to_string();
        }
        let base = self.source_url.as_deref().unwrap_or("http://localhost/");
        match url::Url::parse(base).and_then(|b| b.join(url)) {
            Ok(u) => u.to_string().trim_end_matches('/').to_string(),
            Err(_) => url.to_string(),
        }
    }

    pub fn generate(&self, opts: &GenerateOptions) -> GenerationOutput {
        generate::generate(self, opts)
    }
}

/// Parses JSON or YAML into a JSON value (YAML keys are stringified).
fn parse_value(text: &str) -> Result<Value, String> {
    if text.trim_start().starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(text) {
            return Ok(v);
        }
    }
    let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(text).map_err(|e| e.to_string())?;
    Ok(yaml_to_json(yaml))
}

fn yaml_to_json(v: serde_yaml_ng::Value) -> Value {
    use serde_yaml_ng::Value as Y;
    match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                n.as_f64().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(seq) => Value::Array(seq.into_iter().map(yaml_to_json).collect()),
        Y::Mapping(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        Y::String(s) => s,
                        Y::Number(n) => n.to_string(),
                        Y::Bool(b) => b.to_string(),
                        Y::Null => "null".into(),
                        other => serde_yaml_ng::to_string(&other).unwrap_or_default().trim().to_string(),
                    };
                    (key, yaml_to_json(v))
                })
                .collect(),
        ),
        Y::Tagged(t) => yaml_to_json(t.value),
    }
}

/// Structural validation. Errors block generation; warnings are returned.
fn validate(root: &Value) -> Result<Vec<String>, OpenApiError> {
    let Some(obj) = root.as_object() else {
        return Err(OpenApiError::NotOpenApi("the document is not a JSON/YAML object".into()));
    };
    if obj.contains_key("swagger") {
        return Err(OpenApiError::Unsupported(
            "Swagger 2.0 documents are not supported; convert the spec to OpenAPI 3 first".into(),
        ));
    }
    let version = match obj.get("openapi") {
        Some(Value::String(v)) => v.clone(),
        Some(other) => other.to_string(),
        None => return Err(OpenApiError::NotOpenApi("missing the `openapi` version field".into())),
    };
    let mut warnings = Vec::new();
    let is_31 = version.starts_with("3.1") || version.starts_with("3.2");
    if !(version.starts_with("3.0") || is_31) {
        if version.starts_with("3.") {
            warnings.push(format!("OpenAPI {version} is newer than 3.1; generating on a best-effort basis"));
        } else {
            return Err(OpenApiError::Unsupported(format!("OpenAPI version {version} (expected 3.0 or 3.1)")));
        }
    }
    if !obj.get("info").is_some_and(Value::is_object) {
        return Err(OpenApiError::Invalid("missing the `info` object".into()));
    }
    match obj.get("paths") {
        Some(Value::Object(p)) if p.is_empty() => warnings.push("The specification defines no paths".into()),
        Some(Value::Object(_)) => {}
        Some(_) => return Err(OpenApiError::Invalid("`paths` must be an object".into())),
        None if is_31 => warnings.push("The specification defines no paths".into()),
        None => return Err(OpenApiError::Invalid("missing the `paths` object".into())),
    }
    Ok(warnings)
}
