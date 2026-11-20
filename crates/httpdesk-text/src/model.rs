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
    /// The ending most of the original text's line breaks have (`Crlf` when more are CRLF
    /// than LF): what new and edited text is written with. A file with only CRLF breaks is
    /// read as LF and saved with CRLF throughout.
    pub line_ending: LineEnding,
    /// The original text has both CRLF and LF breaks. It's then read as written, each
    /// `\r` kept in its verbatim text, so what isn't edited saves back byte for byte;
    /// only text written anew (an edited or added request, the lines between blocks)
    /// gets [`Self::line_ending`].
    pub mixed_endings: bool,
    /// The file started with a UTF-8 byte order mark (stripped for parsing, written back on save).
    pub bom: bool,
}

impl HttpFile {
    /// The `# @name`s of the file's requests, in order, each once: what its Request
    /// variables can refer to (`###` text never counts).
    pub fn request_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for name in self.requests.iter().filter_map(Request::request_name) {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
        names
    }
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

/// A Prompt variable: `# @prompt name [description]` (or `// @prompt`) asks for a
/// value when the request is sent (VS Code REST Client).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Prompt {
    pub name: String,
    /// Help text shown with the field; empty when the line has none.
    pub description: String,
}

impl Prompt {
    /// Whether the value is typed masked: the name is `password`, `passwd` or
    /// `pass`, ignoring case (REST Client's list, case-insensitive).
    pub fn masked(&self) -> bool {
        ["password", "passwd", "pass"].iter().any(|n| self.name.eq_ignore_ascii_case(n))
    }
}

/// A query parameter or header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyValue {
    pub enabled: bool,
    pub name: String,
    pub value: String,
    /// Documentation, stored as `# @param name: …` / `# @header Name: …`
    /// lines above the request line (ignored by JetBrains and VS Code).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Query params only: an empty value is written `name=` rather than `name`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub equals: bool,
}

impl Default for KeyValue {
    fn default() -> Self {
        KeyValue { enabled: true, name: String::new(), value: String::new(), description: String::new(), equals: false }
    }
}

impl KeyValue {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        KeyValue { name: name.into(), value: value.into(), ..Default::default() }
    }
    pub fn disabled(name: impl Into<String>, value: impl Into<String>) -> Self {
        KeyValue { enabled: false, ..KeyValue::new(name, value) }
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
    /// `Authorization` header value as written (Basic / Bearer). Re-emitted while it
    /// still parses to the same credentials, so e.g. pre-encoded base64 is kept.
    pub raw: Option<String>,
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
            raw: None,
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

/// An unrecognized header-area line, kept verbatim and in place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtraLine {
    pub text: String,
    /// What the line sat directly above: a header name, or `&name` for a disabled
    /// query param. Emitted before the first such line; `None` (or no longer
    /// present) means after the last header.
    pub before: Option<String>,
}

impl ExtraLine {
    pub fn new(text: impl Into<String>) -> Self {
        ExtraLine { text: text.into(), before: None }
    }
}

/// A script as a request writes it after `<` (pre-request) or `>` (response handler).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptSource {
    /// `{% … %}`: the script text between the markers, and the line of the
    /// pre-request script or handler (1-based) that text starts on, so errors can
    /// name its lines.
    Inline { source: String, line: usize },
    /// `path.js`: a script file, relative to the `.http` file.
    File { path: String },
}

/// One part of a request's response handler (JetBrains `>` / `>>` lines).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandlerPart {
    /// `> {% … %}` or `> path.js`.
    Script(ScriptSource),
    /// `>> path` or `>>! path` (`overwrite`): saves the response to a file.
    /// Preserved, never run.
    Redirect { path: String, overwrite: bool },
}

impl HandlerPart {
    /// A script (inline or a file), as opposed to an output redirect.
    pub fn is_script(&self) -> bool {
        matches!(self, HandlerPart::Script(_))
    }
}

/// One part of a request's pre-request script (JetBrains `<` lines above the
/// request line): every part is a script.
pub type PreRequestPart = ScriptSource;

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
    /// Verbatim JetBrains pre-request script (`< {% … %}`, `< file.js`), as written
    /// back. [`Request::pre_request_parts`] is the form that runs.
    pub pre_script: Option<String>,
    pub method: String,
    /// URL without the query string.
    pub url: String,
    pub http_version: Option<String>,
    pub query: KvSection,
    pub headers: KvSection,
    pub auth: Auth,
    pub body: Body,
    /// Unrecognized lines in the header area (comments etc.), emitted verbatim.
    pub extra_lines: Vec<ExtraLine>,
    /// Verbatim response handler / output redirect (`> {% … %}`, `>> file`), as
    /// written back. [`Request::response_handler_parts`] is the form that runs.
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
        self.directives.iter().find(|d| d.name.eq_ignore_ascii_case(name)).map(|d| d.value.as_str())
    }

    /// The request's Prompt variables, in order. A name declared twice is asked once,
    /// with its first description.
    pub fn prompts(&self) -> Vec<Prompt> {
        let mut out: Vec<Prompt> = Vec::new();
        for d in self.directives.iter().filter(|d| d.name.eq_ignore_ascii_case("prompt")) {
            let value = d.value.trim();
            let (name, description) = value.split_once(char::is_whitespace).unwrap_or((value, ""));
            if !name.is_empty() && !out.iter().any(|p| p.name == name) {
                out.push(Prompt { name: name.to_string(), description: description.trim().to_string() });
            }
        }
        out
    }

    /// The request's `# @name`, which Request variables refer to it by. Its `###` text never is.
    pub fn request_name(&self) -> Option<&str> {
        self.directive("name").map(str::trim).filter(|n| !n.is_empty())
    }

    /// The response handler as structured parts, read from the verbatim
    /// [`Request::response_handler`] (which stays what is written back).
    pub fn response_handler_parts(&self) -> Vec<HandlerPart> {
        self.response_handler.as_deref().map(crate::parser::handler_parts).unwrap_or_default()
    }

    /// The pre-request script as structured parts, read from the verbatim
    /// [`Request::pre_script`] (which stays what is written back).
    pub fn pre_request_parts(&self) -> Vec<PreRequestPart> {
        self.pre_script.as_deref().map(crate::parser::pre_request_parts).unwrap_or_default()
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

/// Something the parser couldn't read cleanly. Reading recovers anyway, and the
/// text is kept as written, so a problem never loses anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// 1-based line in the parsed text.
    pub line: usize,
    /// 1-based column, in characters (a leading byte order mark doesn't count).
    pub column: usize,
    pub severity: Severity,
    pub code: ProblemCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The text doesn't say what was meant.
    Error,
    /// The text reads, but probably not as intended.
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProblemCode {
    /// The request line isn't `[METHOD] URL [HTTP/version]` (e.g. a space in the URL).
    UnparseableRequestLine,
    /// A header line after the blank line that starts the body: it's sent as body text.
    HeaderAfterBody,
    /// A `# @tag` above the request line that neither editor nor HttpDesk knows.
    UnknownDirective,
    /// A `< path` body reference to a file that doesn't exist. The parser can't tell:
    /// it names the file ([`BodyFile`]) and the shell answers whether it exists.
    MissingFile,
    /// A body line HttpDesk once read as a file, `<path` or an indented `< path`, that
    /// isn't a File line: both editors send it as text, and so does HttpDesk (ADR 0010).
    NotAFileLine,
    /// A `###` after the request's block in a single request's text (a Source view): it
    /// starts another block, which a request's text can't hold.
    TextAfterRequest,
}

/// A file and the problems found reading it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFile {
    pub file: HttpFile,
    pub problems: Vec<Problem>,
}

/// A single request's text read on its own, and the problems found reading it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRequest {
    /// `None` when the text has no request line.
    pub request: Option<Request>,
    pub problems: Vec<Problem>,
    /// The files the request's body is read from, placed in the text.
    pub files: Vec<BodyFile>,
    /// The text after the request's block, from the next `###` on, when there is any. A
    /// single request's text holds one block, so it's reported ([`ProblemCode::TextAfterRequest`]),
    /// and kept: Save as written puts it in the file after the request.
    pub following: Option<Following>,
}

/// The text after a single request's block ([`ParsedRequest::following`]), read as a
/// file reads it: its requests (each with the text before it as its `leading`), and
/// the text after the last of them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Following {
    pub requests: Vec<Request>,
    pub trailing: String,
}

impl Following {
    /// The text, as read.
    pub fn text(&self) -> String {
        let mut text: String = self.requests.iter().map(crate::serializer::request_source).collect();
        text.push_str(&self.trailing);
        text
    }
}

/// A file a request's body is read from when it's sent (`< path`, `<@ path`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyFile {
    /// As written: relative to the `.http` file's folder, variables unresolved.
    pub path: String,
    /// The problem to report when the file doesn't exist (`missing-file`), at the reference.
    pub missing: Problem,
}

/// What reading a request's text found ([`crate::parser::request_problems`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestProblems {
    pub problems: Vec<Problem>,
    /// The files its body is read from, which the shell checks exist.
    pub files: Vec<BodyFile>,
}
