//! Internal request model. `.http` files are the source of truth; this model is
//! what they parse into and what the GUI edits. Serialized to the frontend as
//! camelCase JSON (mirrored in `src/lib/types.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    #[default]
    Lf,
    Crlf,
}

/// A parsed `.http` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HttpFile {
    pub header: FileHeader,
    pub requests: Vec<Request>,
    /// Verbatim non-request text after the last request.
    pub trailing: String,
    pub line_ending: LineEnding,
}

/// Content before the first request: `@var = value` lines plus other lines
/// (comments) kept verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FileHeader {
    pub comments: Vec<String>,
    pub variables: Vec<Variable>,
    /// Original text, used to emit the header unchanged when it was not edited.
    pub raw: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Variable {
    pub name: String,
    pub value: String,
}

/// `# @name value` style metadata (`@name`, `@no-redirect`, `@timeout`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Directive {
    pub name: String,
    pub value: String,
}

/// A query parameter or header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyValue {
    pub enabled: bool,
    pub name: String,
    pub value: String,
}

impl Default for KeyValue {
    fn default() -> Self {
        KeyValue { enabled: true, name: String::new(), value: String::new() }
    }
}

impl KeyValue {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        KeyValue { enabled: true, name: name.into(), value: value.into() }
    }
    pub fn disabled(name: impl Into<String>, value: impl Into<String>) -> Self {
        KeyValue { enabled: false, name: name.into(), value: value.into() }
    }
}

/// A list of items with a section-level toggle (all query params / all headers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KvSection {
    pub enabled: bool,
    pub items: Vec<KeyValue>,
}

impl Default for KvSection {
    fn default() -> Self {
        KvSection { enabled: true, items: Vec::new() }
    }
}

impl KvSection {
    /// Items that will actually be sent.
    pub fn active(&self) -> impl Iterator<Item = &KeyValue> {
        let on = self.enabled;
        self.items.iter().filter(move |i| on && i.enabled && !i.name.is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    #[default]
    None,
    Basic,
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ApiKeyLocation {
    #[default]
    Header,
    Query,
}

/// Authentication. Flat so the GUI can switch kinds without losing typed values;
/// only the fields relevant to `kind` are persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Auth {
    pub enabled: bool,
    pub kind: AuthKind,
    pub username: String,
    pub password: String,
    pub token: String,
    pub key_name: String,
    pub key_value: String,
    pub key_location: ApiKeyLocation,
}

impl Default for Auth {
    fn default() -> Self {
        Auth {
            enabled: true,
            kind: AuthKind::None,
            username: String::new(),
            password: String::new(),
            token: String::new(),
            key_name: String::new(),
            key_value: String::new(),
            key_location: ApiKeyLocation::Header,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BodyMode {
    #[default]
    None,
    Json,
    Xml,
    Text,
    FormUrlEncoded,
    Multipart,
    /// `< ./path/to/file`
    File,
    Raw,
}

/// The request body, always stored as `.http` body text. Structured editors in
/// the GUI (form fields, multipart parts) parse and rebuild this text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Body {
    pub enabled: bool,
    pub mode: BodyMode,
    pub text: String,
}

impl Default for Body {
    fn default() -> Self {
        Body { enabled: true, mode: BodyMode::None, text: String::new() }
    }
}

impl Body {
    pub fn is_present(&self) -> bool {
        self.mode != BodyMode::None && !self.text.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    /// `### name`
    pub name: String,
    /// Description comment lines above the request line (without the `#` prefix).
    pub comments: Vec<String>,
    pub directives: Vec<Directive>,
    /// `@var = value` lines inside this request block.
    pub variables: Vec<Variable>,
    /// Verbatim JetBrains pre-request script (`< {% … %}`); preserved, not executed.
    pub pre_script: Option<String>,
    pub method: String,
    /// URL without the query string.
    pub url: String,
    pub http_version: Option<String>,
    pub query: KvSection,
    pub headers: KvSection,
    pub auth: Auth,
    pub body: Body,
    /// Unrecognized lines in the header area, emitted verbatim.
    pub extra_lines: Vec<String>,
    /// Verbatim response handler / output redirect (`> {% … %}`, `>> file`).
    pub response_handler: Option<String>,
    /// Verbatim non-request blocks that precede this request in the file.
    pub leading: String,
    /// Original block text. Lets the serializer emit untouched requests byte-for-byte.
    pub raw: Option<String>,
}

impl Default for Request {
    fn default() -> Self {
        Request {
            name: String::new(),
            comments: Vec::new(),
            directives: Vec::new(),
            variables: Vec::new(),
            pre_script: None,
            method: "GET".into(),
            url: String::new(),
            http_version: None,
            query: KvSection::default(),
            headers: KvSection::default(),
            auth: Auth::default(),
            body: Body::default(),
            extra_lines: Vec::new(),
            response_handler: None,
            leading: String::new(),
            raw: None,
        }
    }
}

impl Request {
    pub fn directive(&self, name: &str) -> Option<&str> {
        self.directives
            .iter()
            .find(|d| d.name.eq_ignore_ascii_case(name))
            .map(|d| d.value.as_str())
    }

    /// Human-friendly label: `### name`, then `@name`, then `METHOD url`.
    pub fn display_name(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.trim().to_string();
        }
        if let Some(n) = self.directive("name").filter(|n| !n.is_empty()) {
            return n.to_string();
        }
        format!("{} {}", self.method, self.url)
    }

    /// Value of the first header with this name (case-insensitive), enabled or not.
    pub fn header(&self, name: &str) -> Option<&KeyValue> {
        self.headers.items.iter().find(|h| h.name.eq_ignore_ascii_case(name))
    }
}
