//! Request execution. [`prepare`] turns a model [`Request`] into the exact bytes
//! to send (applying variables and dropping disabled components). [`execute`]
//! sends it with reqwest on a fresh [`ExecClient`]; [`execute_on`] sends it on
//! a given one, such as an idle client from a [`ClientPool`], so a connection
//! left open by an earlier send can be reused.

mod timing;

pub use timing::Timings;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::body_format::{self, ResponseKind};
use crate::cookies::{self, CookieJar, ResponseCookie};
use crate::env::SslConfig;
use crate::model::*;
use crate::parser::DISABLED_MARKER;
use crate::query::{self, Part};
use crate::vars::Resolver;

mod body;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("Invalid URL \"{url}\": {reason}")]
    InvalidUrl { url: String, reason: String },
    #[error("Invalid HTTP method \"{0}\"")]
    InvalidMethod(String),
    #[error("Invalid header \"{0}\"")]
    InvalidHeader(String),
    #[error("Could not read file {path}: {reason}")]
    File { path: PathBuf, reason: String },
    #[error("TLS configuration error: {0}")]
    Tls(String),
    /// No data arrived for this many ms (`@timeout`, the idle timeout).
    #[error("Read timeout: no data received for {}. Raise it with # @timeout or the idle timeout in Settings.", human_ms(*.0))]
    ReadTimeout(u64),
    /// Connecting (TCP and TLS) took longer than this many ms (`@connection-timeout`).
    #[error("Connection timeout: couldn't connect within {}. Check the host is reachable, or raise it with # @connection-timeout or the connection timeout in Settings.", human_ms(*.0))]
    ConnectTimeout(u64),
    /// The host name didn't resolve. `chain` is the full error chain.
    #[error("{chain}")]
    Dns { host: String, chain: String },
    /// The server's certificate was rejected, or the TLS handshake failed.
    #[error("{chain}")]
    TlsHandshake { reason: TlsReason, chain: String },
    /// Nothing accepted the TCP connection. `chain` is the full error chain.
    #[error("{chain}")]
    Refused { host: String, port: u16, chain: String },
    /// The server closed or reset the connection before answering.
    #[error("{chain}")]
    Reset { host: String, port: u16, chain: String },
    /// Any other failure, as its error chain.
    #[error("{0}")]
    Other(String),
    /// Undefined variables in the URL's scheme or host.
    #[error("The URL's scheme or host uses undefined variables: {}. Pick an environment that defines them, or declare them as file variables.", .0.join(", "))]
    UnresolvedHost(Vec<String>),
    /// Circular references in the URL's scheme or host, each as the chain followed.
    #[error("The URL's scheme or host uses a circular variable reference: {}.", chains_text(.0))]
    CircularHost(Vec<Vec<String>>),
    #[error("{}", .0.join("\n"))]
    DynamicVariable(Vec<String>),
    /// The request has a script, and the workspace isn't a Trusted workspace.
    #[error("This request has a script, and this workspace isn't trusted to run scripts. Trust it, or send without scripts.")]
    UntrustedWorkspace,
}

/// `a → b → a`, chains separated by `; `.
fn chains_text(chains: &[Vec<String>]) -> String {
    chains.iter().map(|c| c.join(" → ")).collect::<Vec<_>>().join("; ")
}

fn human_ms(ms: u64) -> String {
    match ms {
        m if m >= 60_000 && m % 60_000 == 0 => format!("{} min", m / 60_000),
        m if m % 1000 == 0 => format!("{} s", m / 1000),
        m => format!("{m} ms"),
    }
}

/// The class of a failed send, which the UI picks a heading, hint and fix-it
/// button by. Serialised in camelCase (`timeoutIdle`), as `SendError["kind"]`
/// in `src/lib/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Dns,
    Refused,
    Reset,
    Tls,
    TimeoutIdle,
    TimeoutConnect,
    InvalidUrl,
    UnresolvedVariable,
    CircularVariable,
    File,
    UntrustedWorkspace,
    Other,
}

impl ExecError {
    /// The class of failure the UI picks a heading, hint and fix-it buttons by.
    pub fn kind(&self) -> ErrorKind {
        match self {
            ExecError::Dns { .. } => ErrorKind::Dns,
            ExecError::Refused { .. } => ErrorKind::Refused,
            ExecError::Reset { .. } => ErrorKind::Reset,
            ExecError::ReadTimeout(_) => ErrorKind::TimeoutIdle,
            ExecError::ConnectTimeout(_) => ErrorKind::TimeoutConnect,
            ExecError::InvalidUrl { .. } => ErrorKind::InvalidUrl,
            ExecError::UnresolvedHost(_) => ErrorKind::UnresolvedVariable,
            ExecError::CircularHost(_) => ErrorKind::CircularVariable,
            ExecError::File { .. } => ErrorKind::File,
            ExecError::UntrustedWorkspace => ErrorKind::UntrustedWorkspace,
            ExecError::Tls(_) | ExecError::TlsHandshake { .. } => ErrorKind::Tls,
            ExecError::InvalidMethod(_)
            | ExecError::InvalidHeader(_)
            | ExecError::DynamicVariable(_)
            | ExecError::Other(_) => ErrorKind::Other,
        }
    }

    /// The structured facts behind [`Self::kind`], for the UI's hint. `null` when there are none.
    fn details(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            ExecError::Dns { host, .. } => json!({ "host": host }),
            ExecError::Refused { host, port, .. } | ExecError::Reset { host, port, .. } => {
                json!({ "host": host, "port": port })
            }
            ExecError::TlsHandshake { reason, .. } => json!({ "reason": reason }),
            ExecError::Tls(_) => json!({ "reason": TlsReason::Other }),
            ExecError::ReadTimeout(ms) | ExecError::ConnectTimeout(ms) => json!({ "timeoutMs": ms }),
            ExecError::InvalidUrl { url, reason } => json!({ "url": url, "reason": reason }),
            ExecError::UnresolvedHost(names) => json!({ "names": names }),
            ExecError::CircularHost(chains) => json!({ "chains": chains }),
            ExecError::File { path, reason } => json!({ "path": path, "reason": reason }),
            _ => serde_json::Value::Null,
        }
    }
}

/// Why a TLS connection failed, as far as it can be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TlsReason {
    SelfSigned,
    Expired,
    WrongHost,
    UnknownIssuer,
    /// Anything else, including TLS configuration errors (unreadable CA or client certificate).
    Other,
}

/// Send errors reach the UI as `{ kind, message, details }`: the core owns the
/// message, the UI chooses the hint and buttons by kind.
impl Serialize for ExecError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("ExecError", 3)?;
        st.serialize_field("kind", &self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("details", &self.details())?;
        st.end()
    }
}

/// Application-level execution settings (per-request directives override these).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecSettings {
    /// Idle timeout in ms, as JetBrains `@timeout`: the longest wait for the next
    /// data (response headers or a body chunk). 0 disables it. There is no total
    /// deadline, so a download that keeps streaming finishes.
    pub timeout_ms: u64,
    /// Connect timeout in ms (TCP and TLS), as JetBrains `@connection-timeout`. 0 disables it.
    pub connect_timeout_ms: u64,
    pub follow_redirects: bool,
    pub max_redirects: usize,
    pub verify_tls: bool,
    pub ca_cert_path: Option<PathBuf>,
    pub client_cert_path: Option<PathBuf>,
    pub client_key_path: Option<PathBuf>,
    /// Bodies larger than this are truncated.
    pub max_body_bytes: usize,
}

impl Default for ExecSettings {
    fn default() -> Self {
        ExecSettings {
            timeout_ms: 30_000,
            connect_timeout_ms: 10_000,
            follow_redirects: true,
            max_redirects: 10,
            verify_tls: true,
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            max_body_bytes: 100 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[serde(skip)]
    pub body: Option<Vec<u8>>,
    pub follow_redirects: bool,
    pub timeout_ms: u64,
    pub connect_timeout_ms: u64,
    /// `# @no-cookie-jar`: the send neither sends the Session's cookies nor
    /// keeps the ones it receives.
    #[serde(default)]
    pub no_cookie_jar: bool,
    pub warnings: Vec<String>,
}

impl PreparedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Parses `@timeout` / `@connection-timeout` values: `30` (seconds), `500 ms`, `2 m`.
fn parse_duration_ms(v: &str) -> Option<u64> {
    let v = v.trim();
    let split = v.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(v.len());
    let n: f64 = v[..split].parse().ok()?;
    let factor = match v[split..].trim() {
        "" | "s" | "sec" => 1000.0,
        "ms" => 1.0,
        "m" | "min" => 60_000.0,
        _ => return None,
    };
    Some((n * factor) as u64)
}

fn read_file(base_dir: &Path, path: &str) -> Result<Vec<u8>, ExecError> {
    let p = Path::new(path.trim());
    let full = if p.is_absolute() { p.to_path_buf() } else { base_dir.join(p) };
    std::fs::read(&full).map_err(|e| ExecError::File { path: full, reason: e.to_string() })
}

/// Reads a body file by its path as written (variables resolved).
type ReadFile<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>, ExecError>;

/// `< path` (raw) or `<@ path` (variables substituted). `None` if not a file reference.
fn file_reference(line: &str, resolver: &Resolver, read: ReadFile) -> Option<Result<Vec<u8>, ExecError>> {
    let crate::parser::FileReference { substitute, path } = crate::parser::file_reference(line)?;
    let path = resolver.resolve(path);
    Some(read(&path).map(|bytes| {
        if substitute {
            resolver.resolve(&String::from_utf8_lossy(&bytes)).into_bytes()
        } else {
            bytes
        }
    }))
}

fn build_body(body: &Body, resolver: &Resolver, read: ReadFile) -> Result<Option<Vec<u8>>, ExecError> {
    if !body.enabled || !body.is_present() {
        return Ok(None);
    }
    let text = body.text.trim_end();
    if !text.contains('\n') {
        if let Some(file) = file_reference(text, resolver, read) {
            return file.map(Some);
        }
    }
    let bytes = match body.mode {
        BodyMode::Multipart => {
            let mut out = Vec::new();
            // `#~` lines are disabled parts (see the parser).
            for line in text.lines().filter(|l| !l.starts_with(DISABLED_MARKER)) {
                match file_reference(line, resolver, read) {
                    Some(file) => out.extend(file?),
                    None => out.extend(resolver.resolve(line).into_bytes()),
                }
                out.extend(b"\r\n");
            }
            out
        }
        BodyMode::FormUrlEncoded => resolver.resolve(&join_form_lines(text)).into_bytes(),
        _ => resolver.resolve(text).into_bytes(),
    };
    Ok(Some(bytes))
}

/// Joins a form body written one field per line with `&`. Lines that already
/// start (or the previous line ends) with `&`, as VS Code writes them, are kept.
/// Comment lines, including `#~` disabled fields, are skipped as JetBrains and
/// VS Code do, and so is the `&` left in front of the first field sent.
fn join_form_lines(text: &str) -> String {
    let mut out = String::new();
    let fields = text.lines().map(str::trim).filter(|l| !l.is_empty() && crate::parser::comment_body(l).is_none());
    for line in fields {
        let line = if out.is_empty() { line.trim_start_matches('&') } else { line };
        if !out.is_empty() && !out.ends_with('&') && !line.starts_with('&') {
            out.push('&');
        }
        out.push_str(line);
    }
    out
}

fn default_content_type(mode: BodyMode) -> Option<&'static str> {
    match mode {
        BodyMode::Json => Some("application/json"),
        BodyMode::Xml => Some("application/xml"),
        BodyMode::Text => Some("text/plain"),
        BodyMode::FormUrlEncoded => Some("application/x-www-form-urlencoded"),
        _ => None,
    }
}

fn dynamic_errors(resolver: &Resolver) -> Result<(), ExecError> {
    let errors = resolver.errors();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ExecError::DynamicVariable(errors))
    }
}

/// The URL without its query string and fragment, which may themselves contain `://`.
fn before_query(url: &str) -> &str {
    &url[..url.find(['?', '#']).unwrap_or(url.len())]
}

fn has_scheme(url: &str) -> bool {
    before_query(url).contains("://")
}

/// The `scheme://user:pass@host:port` part of an absolute URL.
fn origin(url: &str) -> &str {
    let url = before_query(url);
    let start = url.find("://").map_or(0, |i| i + 3);
    &url[..start + url[start..].find('/').unwrap_or(url.len() - start)]
}

/// Names of the `{{name}}` references left in `text`, in order of appearance.
fn variable_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for segment in crate::vars::segments(text) {
        if let crate::vars::Segment::Reference { name, .. } = segment {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// Fails when references are left in the URL's scheme or host after resolving: as
/// undefined variables if any of them is undefined, else as circular references.
/// A circular reference stops at the name that repeats, so that's the name left in the
/// URL; the chains reported are the ones ending at a name left there.
fn host_check(url: &str, resolver: &Resolver) -> Result<(), ExecError> {
    let left = variable_names(origin(url));
    if left.is_empty() {
        return Ok(());
    }
    let chains: Vec<Vec<String>> =
        resolver.circular().into_iter().filter(|c| c.last().is_some_and(|name| left.contains(name))).collect();
    let undefined: Vec<String> =
        left.into_iter().filter(|name| !chains.iter().any(|c| c.last() == Some(name))).collect();
    if !undefined.is_empty() || chains.is_empty() {
        return Err(ExecError::UnresolvedHost(undefined));
    }
    Err(ExecError::CircularHost(chains))
}

/// A query param as sent (ADR-0001): written as in the file, variables resolved, then
/// percent-encoded unless the request has `# @no-auto-encoding`. Escaping and encoding
/// go part by part, so `&`, `=` or `#` from a variable can't split the param.
fn wire_param(p: &KeyValue, resolver: &Resolver, auto_encode: bool) -> String {
    let part = |text: &str, part: Part| {
        let written = query::escape(text, part);
        if auto_encode {
            query::encode(&written, part, |r| resolver.resolve(r))
        } else {
            resolver.resolve(&written)
        }
    };
    let name = part(&p.name, Part::Name);
    if p.value.is_empty() && !p.equals {
        name
    } else {
        format!("{name}={}", part(&p.value, Part::Value))
    }
}

/// Sent when the request sets no `Accept-Encoding`: every encoding `body` can decode.
const DEFAULT_ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";

/// The Content-Type a body implies when the request sets none. Decided from the
/// body's mode alone, so the preview can show it without building the body.
fn implied_content_type(body: &Body) -> Option<&'static str> {
    if body.enabled && body.is_present() {
        default_content_type(body.mode)
    } else {
        None
    }
}

/// The method, URL and headers of a request: everything [`prepare`] and [`preview`]
/// share except the body.
struct Head {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    /// A relative URL without a `Host` header, the one failure: it comes alongside
    /// the URL as written so the preview can show it.
    error: Option<ExecError>,
}

fn head(req: &Request, resolver: &Resolver) -> Head {
    let method = req.method.trim().to_ascii_uppercase();
    let method = if method.is_empty() { "GET".to_string() } else { method };

    // Headers
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(header) = auth_header(&req.auth, resolver) {
        headers.push(header);
    }
    headers.extend(req.headers.active().map(|h| (resolver.resolve(&h.name), resolver.resolve(&h.value))));

    // URL
    let mut url = resolver.resolve(req.url.trim());
    let auto_encode = req.directive("no-auto-encoding").is_none();
    let mut params: Vec<String> = req.query.active().map(|p| wire_param(p, resolver, auto_encode)).collect();
    if let Some(param) = auth_param(&req.auth, resolver, auto_encode) {
        params.push(param);
    }
    if !params.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&params.join("&"));
    }
    let mut error = None;
    // One still starting with an undefined `{{base}}` can't be sent; it's shown as written.
    // (In the preview a Secret's value is marked: the check reads the value.)
    let plain = resolver.unmarked(&url);
    if !has_scheme(&plain) && !plain.starts_with("{{") {
        if !url.starts_with('/') {
            url = format!("http://{url}");
        } else if let Some((_, host)) = headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("host")) {
            url = format!("http://{host}{url}");
        } else {
            error = Some(ExecError::InvalidUrl { url: url.clone(), reason: "relative URL needs a Host header".into() });
        }
    }
    Head { method, url, headers, error }
}

/// The header that enabled Basic, Bearer or header API-key auth adds.
fn auth_header(auth: &Auth, resolver: &Resolver) -> Option<(String, String)> {
    if !auth.enabled {
        return None;
    }
    match auth.kind {
        AuthKind::Basic => {
            let creds = format!("{}:{}", resolver.resolve(&auth.username), resolver.resolve(&auth.password));
            // Base64 would hide a preview's placeholders, so those credentials are shown unencoded.
            let encoded = if resolver.has_placeholders(&creds) {
                format!("base64({creds})")
            } else {
                base64::engine::general_purpose::STANDARD.encode(creds)
            };
            Some(("Authorization".into(), format!("Basic {encoded}")))
        }
        AuthKind::Bearer => Some(("Authorization".into(), format!("Bearer {}", resolver.resolve(auth.token.trim())))),
        AuthKind::ApiKey if auth.key_location == ApiKeyLocation::Header && !auth.key_name.is_empty() => {
            Some((auth.key_name.clone(), resolver.resolve(&auth.key_value)))
        }
        _ => None,
    }
}

/// The query param that enabled query API-key auth adds, as sent.
fn auth_param(auth: &Auth, resolver: &Resolver, auto_encode: bool) -> Option<String> {
    let query_key = auth.kind == AuthKind::ApiKey && auth.key_location == ApiKeyLocation::Query;
    (auth.enabled && query_key && !auth.key_name.is_empty())
        .then(|| wire_param(&KeyValue::new(&auth.key_name, &auth.key_value), resolver, auto_encode))
}

/// Why a URL can't be sent: undefined or circular variables left in its scheme or
/// host (see [`host_check`]), or it doesn't parse.
fn url_error(url: &str, resolver: &Resolver) -> Option<ExecError> {
    if let Err(e) = host_check(url, resolver) {
        return Some(e);
    }
    url::Url::parse(url).err().map(|e| ExecError::InvalidUrl { url: url.to_string(), reason: e.to_string() })
}

/// Adds the headers every send carries unless the request sets them: the
/// Content-Type the body implies, `User-Agent` and `Accept-Encoding`.
fn add_default_headers(body: &Body, headers: &mut Vec<(String, String)>) {
    let has = |headers: &[(String, String)], name: &str| headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name));
    if let Some(ct) = implied_content_type(body).filter(|_| !has(headers, "content-type")) {
        headers.push(("Content-Type".into(), ct.into()));
    }
    if !has(headers, "user-agent") {
        headers.push(("User-Agent".into(), concat!("HttpDesk/", env!("CARGO_PKG_VERSION")).into()));
    }
    // Added here rather than by reqwest so the Request tab shows it.
    if !has(headers, "accept-encoding") {
        headers.push(("Accept-Encoding".into(), DEFAULT_ACCEPT_ENCODING.into()));
    }
}

fn warnings(req: &Request, resolver: &Resolver, headers: &[(String, String)]) -> Vec<String> {
    let mut warnings = Vec::new();
    let undefined = resolver.undefined();
    if !undefined.is_empty() {
        warnings.push(format!("Undefined variables: {}", undefined.join(", ")));
    }
    for chain in resolver.circular() {
        warnings.push(format!("Circular variable reference: {}", chain.join(" → ")));
    }
    if req.body.enabled && req.body.mode == BodyMode::Multipart {
        let ct =
            headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.as_str()).unwrap_or("");
        if !ct.contains("boundary=") {
            warnings.push("Multipart body without a boundary in Content-Type".into());
        }
    }
    warnings
}

/// Resolves variables and applies enablement. Disabled components are never included.
pub fn prepare(
    req: &Request,
    resolver: &Resolver,
    base_dir: &Path,
    settings: &ExecSettings,
) -> Result<PreparedRequest, ExecError> {
    let Head { method, url, mut headers, error } = head(req, resolver);
    if let Some(e) = error {
        return Err(e);
    }
    dynamic_errors(resolver)?;
    if let Some(e) = url_error(&url, resolver) {
        return Err(e);
    }

    let body = build_body(&req.body, resolver, &|path| read_file(base_dir, path))?;
    dynamic_errors(resolver)?;
    add_default_headers(&req.body, &mut headers);
    let warnings = warnings(req, resolver, &headers);

    let timeout_ms = req.directive("timeout").and_then(parse_duration_ms).unwrap_or(settings.timeout_ms);
    let connect_timeout_ms =
        req.directive("connection-timeout").and_then(parse_duration_ms).unwrap_or(settings.connect_timeout_ms);
    let follow_redirects = settings.follow_redirects && req.directive("no-redirect").is_none();
    let no_cookie_jar = req.directive("no-cookie-jar").is_some();

    Ok(PreparedRequest {
        method,
        url,
        headers,
        body,
        follow_redirects,
        timeout_ms,
        connect_timeout_ms,
        no_cookie_jar,
        warnings,
    })
}

/// What [`preview`] shows: the method, URL and headers a send would produce.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPreview {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// The enabled auth's fields, resolved and labelled as in the Authorization section.
    pub auth: Vec<(String, String)>,
    /// The same warnings a send would report.
    pub warnings: Vec<String>,
    /// Why a send would fail before reaching the network, if it would.
    pub error: Option<ExecError>,
}

fn auth_fields(auth: &Auth, resolver: &Resolver) -> Vec<(String, String)> {
    let fields: &[(&str, &str)] = match auth.kind {
        _ if !auth.enabled => &[],
        AuthKind::Basic => &[("Username", &auth.username), ("Password", &auth.password)],
        AuthKind::Bearer => &[("Token", auth.token.trim())],
        AuthKind::ApiKey => &[("Key", &auth.key_name), ("Value", &auth.key_value)],
        AuthKind::None => &[],
    };
    // The key name is sent as written, like at send.
    let resolve = |label: &str, text: &str| if label == "Key" { text.to_string() } else { resolver.resolve(text) };
    fields.iter().map(|(label, text)| (label.to_string(), resolve(label, text))).collect()
}

/// The request as [`prepare`] would make it, without sending it. Dynamic variables
/// that generate a new value on every send are shown as written, not generated.
/// Each value a Secret went into is between [`crate::vars::SECRET_MARKS`], for the UI
/// to mask (never in `error`, which masks it). The body isn't shown and no file is
/// read, but the Content-Type it implies is.
pub fn preview(req: &Request, resolver: Resolver) -> RequestPreview {
    let resolver = resolver.previewing();
    let Head { method, url, mut headers, error } = head(req, &resolver);
    // A placeholder stands for a plain value, so check the URL with one in its place.
    let checked = resolver.unmarked(&resolver.replace_placeholders(&url, |_| "0".into()));
    // The message names the URL as shown, with any Secret in it masked.
    let error = error.or_else(|| url_error(&checked, &resolver)).map(|e| match e {
        ExecError::InvalidUrl { reason, .. } => {
            ExecError::InvalidUrl { url: resolver.masked(&resolver.shown(&url)), reason }
        }
        e => e,
    });
    // Built only so its undefined variables are reported as at send; files read as empty.
    let _ = build_body(&req.body, &resolver, &|_| Ok(Vec::new()));
    add_default_headers(&req.body, &mut headers);
    let auth = auth_fields(&req.auth, &resolver);
    let warnings = warnings(req, &resolver, &headers);
    let shown =
        |pairs: &[(String, String)]| pairs.iter().map(|(n, v)| (resolver.shown(n), resolver.shown(v))).collect();
    RequestPreview { method, url: resolver.shown(&url), headers: shown(&headers), auth: shown(&auth), warnings, error }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_preview: Option<String>,
    pub body_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub id: String,
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    /// Final URL after redirects.
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub time_ms: f64,
    pub ttfb_ms: f64,
    /// Decoded body size (what the viewer shows and the size limit applies to).
    pub body_size: usize,
    /// Body bytes as received on the wire, before `Content-Encoding` is undone.
    pub transferred_size: usize,
    pub headers_size: usize,
    pub content_type: Option<String>,
    /// What the body is, for the viewer, including whether it's text or binary
    /// (see [`body_kind`]). The response carries no body: the viewer fetches it
    /// by id from the shell, which keeps [`ExecOutcome::body`] (ADR 0006).
    #[serde(default)]
    pub body_kind: ResponseKind,
    /// The response's `Content-Encoding` header, as sent by the server.
    pub content_encoding: Option<String>,
    pub truncated: bool,
    pub request: SentRequest,
    pub warnings: Vec<String>,
    /// Phase timing of the final request (`time_ms` covers every hop).
    #[serde(default)]
    pub timings: Timings,
    /// Every `Set-Cookie` received, redirect hops first, each with the URL
    /// that set it. Shown only; never sent back.
    pub cookies: Vec<ResponseCookie>,
    /// The response handler's `client.test`/`client.assert` results and its
    /// own failure, if any (see [`crate::script`]). Empty when nothing ran.
    #[serde(default)]
    pub tests: Vec<crate::script::TestResult>,
    /// What the scripts logged. Empty until `client.log` is implemented.
    #[serde(default)]
    pub logs: Vec<String>,
}

pub struct ExecOutcome {
    pub response: HttpResponse,
    /// The complete (possibly truncated) body, after Content-Encoding is undone
    /// (or as received, if it couldn't be).
    pub body: Vec<u8>,
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        source = s.source();
    }
    msg
}

/// Every error in `e`'s source chain, including the ones `std::io::Error` wraps
/// (its `source()` skips the wrapped error itself, which is where rustls and
/// OS errors live).
fn causes<'a>(e: &'a (dyn std::error::Error + 'static)) -> Vec<&'a (dyn std::error::Error + 'static)> {
    let mut out = Vec::new();
    let mut next = Some(e);
    while let Some(err) = next {
        out.push(err);
        next = match err.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            Some(wrapped) => Some(wrapped),
            None => err.source(),
        };
    }
    out
}

/// Turns a transport failure into the error kind the UI explains. Async because
/// a rejected certificate may be fetched again to tell why (see [`crate::tls_probe`]).
async fn classify(e: reqwest::Error, p: &PreparedRequest) -> ExecError {
    match (e.is_timeout(), e.is_connect()) {
        (true, true) if p.connect_timeout_ms > 0 => return ExecError::ConnectTimeout(p.connect_timeout_ms),
        (true, false) if p.timeout_ms > 0 => return ExecError::ReadTimeout(p.timeout_ms),
        _ => {}
    }
    let chain = error_chain(&e);
    let url = e.url().cloned().or_else(|| url::Url::parse(&p.url).ok());
    let host = url.as_ref().and_then(|u| u.host_str()).unwrap_or_default().trim_matches(['[', ']']).to_string();
    let port = url.as_ref().and_then(url::Url::port_or_known_default).unwrap_or_default();
    use std::io::ErrorKind as K;
    let io_kind = |kinds: &[K]| {
        causes(&e).iter().any(|c| c.downcast_ref::<std::io::Error>().is_some_and(|io| kinds.contains(&io.kind())))
    };
    // hyper-util's and reqwest's resolver errors are private types, so they're known by their text.
    if causes(&e).iter().any(|c| matches!(c.to_string().as_str(), "dns error" | "error resolving DNS")) {
        return ExecError::Dns { host, chain };
    }
    let tls = causes(&e).into_iter().find_map(|c| c.downcast_ref::<rustls::Error>().cloned());
    if let Some(tls) = tls {
        use rustls::CertificateError as C;
        let reason = match tls {
            rustls::Error::InvalidCertificate(C::Expired | C::ExpiredContext { .. }) => TlsReason::Expired,
            rustls::Error::InvalidCertificate(C::NotValidForName | C::NotValidForNameContext { .. }) => {
                TlsReason::WrongHost
            }
            rustls::Error::InvalidCertificate(cert) => {
                let timeout = Duration::from_millis(match p.connect_timeout_ms {
                    0 => 5_000,
                    ms => ms.min(5_000),
                });
                // Behind a proxy, the verifier's reason is all there is.
                let found = match &url {
                    Some(u) if !crate::tls_probe::through_proxy(u) => {
                        crate::tls_probe::certificate_reason(&host, port, timeout).await
                    }
                    _ => None,
                };
                found.unwrap_or(if cert == C::UnknownIssuer { TlsReason::UnknownIssuer } else { TlsReason::Other })
            }
            _ => TlsReason::Other,
        };
        return ExecError::TlsHandshake { reason, chain };
    }
    if io_kind(&[K::ConnectionRefused]) {
        return ExecError::Refused { host, port, chain };
    }
    let hung_up =
        causes(&e).iter().any(|c| c.downcast_ref::<hyper::Error>().is_some_and(hyper::Error::is_incomplete_message));
    if hung_up || io_kind(&[K::ConnectionReset, K::ConnectionAborted, K::BrokenPipe, K::UnexpectedEof]) {
        return ExecError::Reset { host, port, chain };
    }
    ExecError::Other(chain)
}

/// A reqwest client set up for one prepared request (redirects, timeouts, TLS),
/// with the hooks that time its phases and record the cookies its responses
/// set. [`execute`] builds one per send; [`execute_on`] reuses one, which lets
/// a later request go over a connection that is still open. A client belongs to
/// no Session: each send tells it which cookie jar to use.
///
/// It times and records one request at a time: concurrent sends on one client
/// would mix their phases, cookies and jars. [`ClientPool`] keeps to that.
pub struct ExecClient {
    http: reqwest::Client,
    timing: timing::Recorder,
    cookies: Arc<cookies::Recorder>,
}

/// One send's use of its client's cookie store. Dropping it, however the send
/// ends (finished, failed or cancelled), lets go of the send's jar.
struct CookieSend<'a>(&'a cookies::Recorder);

impl CookieSend<'_> {
    /// The cookies the send's responses set, and the `Cookie` header the jar
    /// gave its final hop.
    fn finish(self) -> (Vec<ResponseCookie>, Option<String>) {
        self.0.finish()
    }
}

impl Drop for CookieSend<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}

impl ExecClient {
    /// Builds a client with `p`'s redirect and timeout settings plus the TLS
    /// settings. Fails with [`ExecError::Tls`] if a certificate can't be read.
    pub fn new(p: &PreparedRequest, settings: &ExecSettings, ssl: &SslConfig) -> Result<Self, ExecError> {
        let timing = timing::Recorder::default();
        let cookies = Arc::new(cookies::Recorder::default());
        let http = build_client(p, settings, ssl, &timing, cookies.clone())?;
        Ok(Self { http, timing, cookies })
    }
}

/// Everything [`build_client`] builds a client from, so two sends with equal
/// keys can share one. Certificate files are identified by path, size and
/// modification time, so replacing one builds a new client. The proxy
/// environment variables are read when the client is built, so they're part of
/// it too.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClientKey {
    follow_redirects: bool,
    max_redirects: usize,
    accept_invalid_certs: bool,
    timeout_ms: u64,
    connect_timeout_ms: u64,
    files: Vec<Option<FileStamp>>,
    proxy_env: Vec<Option<std::ffi::OsString>>,
}

/// A certificate file as a [`ClientKey`] sees it: its path, and its size and
/// modification time if it can be read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    stamp: Option<(u64, std::time::SystemTime)>,
}

impl ClientKey {
    fn new(p: &PreparedRequest, settings: &ExecSettings, ssl: &SslConfig) -> Self {
        let file = |path: Option<&PathBuf>| {
            path.map(|path| {
                let stamp = std::fs::metadata(path).ok().and_then(|m| Some((m.len(), m.modified().ok()?)));
                FileStamp { path: path.clone(), stamp }
            })
        };
        let cert = ssl.client_certificate.as_ref().or(settings.client_cert_path.as_ref());
        let key = ssl.client_certificate_key.as_ref().or(settings.client_key_path.as_ref());
        let proxy_vars = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];
        ClientKey {
            follow_redirects: p.follow_redirects,
            max_redirects: settings.max_redirects,
            accept_invalid_certs: !settings.verify_tls || ssl.verify_host_certificate == Some(false),
            timeout_ms: p.timeout_ms,
            connect_timeout_ms: p.connect_timeout_ms,
            files: vec![file(settings.ca_cert_path.as_ref()), file(cert), file(key)],
            proxy_env: proxy_vars
                .iter()
                .flat_map(|v| [v.to_string(), v.to_ascii_uppercase()])
                .chain(["REQUEST_METHOD".to_string()])
                .map(std::env::var_os)
                .collect(),
        }
    }
}

/// At most this many idle clients are kept; the longest idle goes first.
pub const MAX_IDLE_CLIENTS: usize = 8;

/// Idle [`ExecClient`]s kept between sends, so a send can go over a
/// connection an earlier one left open. [`ClientPool::checkout`] hands out an
/// idle client built with the same settings, or builds a new one; a client
/// is never handed out while it's checked out, so each times one request at a
/// time. Cloning shares the pool.
#[derive(Clone, Default)]
pub struct ClientPool {
    idle: Arc<Mutex<Vec<(ClientKey, ExecClient)>>>,
}

impl ClientPool {
    /// An idle client for sending `p` with these settings, or a new one. It
    /// returns to the pool when the [`PooledClient`] is dropped.
    pub fn checkout(
        &self,
        p: &PreparedRequest,
        settings: &ExecSettings,
        ssl: &SslConfig,
    ) -> Result<PooledClient, ExecError> {
        let key = ClientKey::new(p, settings, ssl);
        let idle = {
            let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
            // The most recently used one has the warmest connections.
            idle.iter().rposition(|(k, _)| *k == key).map(|i| idle.remove(i).1)
        };
        let client = match idle {
            Some(client) => client,
            None => ExecClient::new(p, settings, ssl)?,
        };
        Ok(PooledClient { entry: Some((key, client)), pool: self.clone() })
    }
}

/// A client checked out of a [`ClientPool`]; dropping it returns it.
pub struct PooledClient {
    entry: Option<(ClientKey, ExecClient)>,
    pool: ClientPool,
}

impl std::ops::Deref for PooledClient {
    type Target = ExecClient;

    fn deref(&self) -> &ExecClient {
        &self.entry.as_ref().expect("present until dropped").1
    }
}

impl Drop for PooledClient {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            let mut idle = self.pool.idle.lock().unwrap_or_else(|e| e.into_inner());
            idle.push(entry);
            if idle.len() > MAX_IDLE_CLIENTS {
                idle.remove(0);
            }
        }
    }
}

fn build_client(
    p: &PreparedRequest,
    settings: &ExecSettings,
    ssl: &SslConfig,
    timing: &timing::Recorder,
    cookies: Arc<cookies::Recorder>,
) -> Result<reqwest::Client, ExecError> {
    let redirect = if p.follow_redirects {
        timing.redirects(reqwest::redirect::Policy::limited(settings.max_redirects))
    } else {
        reqwest::redirect::Policy::none()
    };
    // Decoding happens in `body` so the raw bytes can be counted. These also
    // guard against another crate enabling reqwest's decompression features.
    let mut b = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .cookie_provider(cookies)
        .redirect(redirect)
        .dns_resolver(timing.resolver())
        .connector_layer(timing.layer())
        .danger_accept_invalid_certs(!settings.verify_tls || ssl.verify_host_certificate == Some(false));
    if p.timeout_ms > 0 {
        b = b.read_timeout(Duration::from_millis(p.timeout_ms));
    }
    if p.connect_timeout_ms > 0 {
        b = b.connect_timeout(Duration::from_millis(p.connect_timeout_ms));
    }
    if let Some(ca) = &settings.ca_cert_path {
        let bytes = std::fs::read(ca).map_err(|e| ExecError::Tls(format!("{}: {e}", ca.display())))?;
        let cert = reqwest::Certificate::from_pem(&bytes)
            .or_else(|_| reqwest::Certificate::from_der(&bytes))
            .map_err(|e| ExecError::Tls(error_chain(&e)))?;
        b = b.add_root_certificate(cert);
    }
    let cert = ssl.client_certificate.as_ref().or(settings.client_cert_path.as_ref());
    let key = ssl.client_certificate_key.as_ref().or(settings.client_key_path.as_ref());
    if let Some(cert) = cert {
        let mut pem = std::fs::read(cert).map_err(|e| ExecError::Tls(format!("{}: {e}", cert.display())))?;
        if let Some(key) = key {
            pem.push(b'\n');
            pem.extend(std::fs::read(key).map_err(|e| ExecError::Tls(format!("{}: {e}", key.display())))?);
        }
        let id = reqwest::Identity::from_pem(&pem).map_err(|e| ExecError::Tls(error_chain(&e)))?;
        b = b.identity(id);
    }
    b.build().map_err(|e| ExecError::Tls(error_chain(&e)))
}

fn is_textual(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("text/")
        || ["json", "xml", "javascript", "ecmascript", "x-www-form-urlencoded", "yaml", "csv", "graphql", "html"]
            .iter()
            .any(|t| ct.contains(t))
}

/// A body as text: in its `charset`, else UTF-8 for textual or unknown content
/// types; `None` for binary. The shell decodes stored bodies with it, through
/// [`body_text`].
pub fn decode_text(bytes: &[u8], content_type: Option<&str>) -> Option<String> {
    let charset = content_type.and_then(|ct| {
        ct.split(';').find_map(|p| p.trim().strip_prefix("charset=").map(|c| c.trim_matches('"').to_string()))
    });
    if let Some(enc) = charset.as_deref().and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes())) {
        return Some(enc.decode(bytes).0.into_owned());
    }
    match (content_type, std::str::from_utf8(bytes)) {
        (_, Ok(s)) if content_type.is_none_or(is_textual) => Some(s.to_string()),
        (Some(ct), Err(_)) if is_textual(ct) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

/// What the viewer treats a received body as (see [`body_format::response_kind`]).
/// Bytes kept `as_received`, because their Content-Encoding couldn't be undone,
/// are binary whatever the content type says, as is a body with no text for a
/// content type that names a text kind.
fn body_kind(body: &[u8], content_type: Option<&str>, as_received: bool) -> ResponseKind {
    if as_received {
        return ResponseKind::Binary;
    }
    let text = decode_text(body, content_type);
    match body_format::response_kind(content_type, text.as_deref()) {
        kind if kind.is_text() && text.is_none() => ResponseKind::Binary,
        kind => kind,
    }
}

/// A stored body as the text the viewer shows (decoded as [`decode_text`]
/// does), or `None` when its `kind` is binary.
pub fn body_text(body: &[u8], content_type: Option<&str>, kind: ResponseKind) -> Option<String> {
    kind.is_text().then(|| decode_text(body, content_type)).flatten()
}

/// What the Request tab shows: the request as it reached the server that sent
/// the final response. Without redirects that is `p`. After them it is rebuilt
/// with the rules reqwest (and tower-http's follow-redirect under it) applies
/// to each hop:
/// - 301/302 turn a POST into a GET, and 303 turns anything but HEAD into a
///   GET; both drop the body and its Content-Type, Content-Length,
///   Content-Encoding and Transfer-Encoding headers, for every later hop too.
/// - A hop to another origin (scheme, host or port) than the one before it
///   leaves out Authorization, Cookie, Cookie2, Proxy-Authorization and
///   WWW-Authenticate. Each hop starts again from the request's headers, so
///   this depends on the final hop only.
/// - The final hop carries a Referer naming the URL before it (without
///   userinfo or fragment), except from https to http.
///
/// It's a reconstruction: headers reqwest adds itself (Host, Accept, ...)
/// aren't listed.
fn final_request(p: &PreparedRequest, hops: &[timing::Hop], final_url: &str) -> SentRequest {
    let mut method = p.method.clone();
    let mut body = p.body.as_deref();
    let mut headers = p.headers.clone();
    let without = |headers: &mut Vec<(String, String)>, names: &[&str]| {
        headers.retain(|(n, _)| !names.iter().any(|g| n.eq_ignore_ascii_case(g)));
    };
    let payload = ["content-type", "content-length", "content-encoding", "transfer-encoding"];
    for hop in hops {
        let to_get = match hop.status {
            301 | 302 if method == "POST" => true,
            303 => method != "HEAD",
            _ => continue,
        };
        if to_get {
            method = "GET".into();
        }
        body = None;
        without(&mut headers, &payload);
    }
    if let Some(last) = hops.last() {
        let (to, from) = (&last.to, &last.from);
        let cross_origin = to.host_str() != from.host_str()
            || to.port_or_known_default() != from.port_or_known_default()
            || to.scheme() != from.scheme();
        if cross_origin {
            without(&mut headers, &["authorization", "cookie", "cookie2", "proxy-authorization", "www-authenticate"]);
        }
        if !(to.scheme() == "http" && from.scheme() == "https") {
            let mut referer = from.clone();
            let _ = referer.set_username("");
            let _ = referer.set_password(None);
            referer.set_fragment(None);
            match headers.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case("referer")) {
                Some((_, v)) => *v = referer.to_string(),
                None => headers.push(("Referer".into(), referer.to_string())),
            }
        }
    }
    SentRequest {
        method,
        url: if hops.is_empty() { p.url.clone() } else { final_url.to_string() },
        headers,
        body_size: body.map_or(0, <[u8]>::len),
        body_preview: body.map(|b| {
            let s = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).into_owned();
            if b.len() > 64 * 1024 {
                format!("{s}\n… ({} bytes total)", b.len())
            } else {
                s
            }
        }),
    }
}

/// Sends `p` on a new [`ExecClient`] built for it, with no cookie jar.
pub async fn execute(p: PreparedRequest, settings: &ExecSettings, ssl: &SslConfig) -> Result<ExecOutcome, ExecError> {
    let client = ExecClient::new(&p, settings, ssl)?;
    execute_on(&client, p, settings, None, |_| {}).await
}

/// The shortest gap between two progress reports, so a body arriving in many
/// small chunks doesn't flood the UI (at most ~10 reports a second).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Sends `p` on `client`, which keeps the redirect, timeout and TLS settings
/// it was built with; `settings` supplies the body size limit. While the body
/// downloads, `on_progress` gets the body bytes received on the wire so far:
/// at most once per [`PROGRESS_INTERVAL`], each larger than the last, and none
/// after the function returns.
///
/// `jar` is the cookie jar of the Session the send belongs to: its matching
/// cookies are sent, on every redirect hop, and the cookies each hop sets are
/// kept in it. With none, or with `# @no-cookie-jar`, no cookie is sent or kept.
/// Either way the response lists the cookies it set.
pub async fn execute_on(
    client: &ExecClient,
    p: PreparedRequest,
    settings: &ExecSettings,
    jar: Option<&CookieJar>,
    mut on_progress: impl FnMut(usize) + Send,
) -> Result<ExecOutcome, ExecError> {
    let method =
        reqwest::Method::from_bytes(p.method.as_bytes()).map_err(|_| ExecError::InvalidMethod(p.method.clone()))?;
    let mut builder = client.http.request(method, &p.url);
    for (n, v) in &p.headers {
        let name =
            reqwest::header::HeaderName::from_bytes(n.as_bytes()).map_err(|_| ExecError::InvalidHeader(n.clone()))?;
        let value =
            reqwest::header::HeaderValue::from_str(v).map_err(|_| ExecError::InvalidHeader(format!("{n}: {v}")))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = &p.body {
        builder = builder.body(body.clone());
    }

    client.timing.reset();
    // This response lists only the cookies set while it was being fetched, and
    // the client lets go of the jar however the send ends.
    client.cookies.start(jar.filter(|_| !p.no_cookie_jar).cloned());
    let cookies = CookieSend(&client.cookies);
    let start = Instant::now();
    let mut resp = match builder.send().await {
        Ok(resp) => resp,
        Err(e) => return Err(classify(e, &p).await),
    };
    let headers_at = Instant::now();
    let ttfb = headers_at - start;

    let status = resp.status();
    let http_version = format!("{:?}", resp.version());
    let final_url = resp.url().to_string();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(n, v)| (n.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let headers_size = headers.iter().map(|(n, v)| n.len() + v.len() + 4).sum::<usize>();
    let content_type =
        resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);

    let content_encoding = resp
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string());

    // A body that can't be decoded (an unknown encoding, or bytes that don't
    // decode) is kept as received, with a warning.
    let (mut reader, unsupported) = body::BodyReader::new(content_encoding.as_deref(), settings.max_body_bytes);
    let mut last_report: Option<Instant> = None;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(classify(e, &p).await),
        };
        if !reader.push(&chunk) {
            break;
        }
        // The first chunk reports at once; after that, once per interval.
        if last_report.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) && !chunk.is_empty() {
            last_report = Some(Instant::now());
            on_progress(reader.transferred());
        }
    }
    let body::ReceivedBody { bytes: body, transferred, truncated, decode_failure } = reader.finish();
    let as_received = unsupported.is_some() || decode_failure.is_some();
    let end = Instant::now();
    let elapsed = end - start;
    let timings = client.timing.timings(start, headers_at, end);
    let (cookies, jar_cookie) = cookies.finish();
    let mut request = final_request(&p, &client.timing.hops(), &final_url);
    if let Some(value) = jar_cookie {
        request.headers.push(("Cookie".into(), value));
    }
    let mut warnings = p.warnings;
    warnings.extend(unsupported);
    warnings.extend(decode_failure);

    let body_kind = body_kind(&body, content_type.as_deref(), as_received);

    Ok(ExecOutcome {
        response: HttpResponse {
            id: uuid::Uuid::new_v4().to_string(),
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            http_version,
            url: final_url,
            headers,
            time_ms: elapsed.as_secs_f64() * 1000.0,
            ttfb_ms: ttfb.as_secs_f64() * 1000.0,
            body_size: body.len(),
            transferred_size: transferred,
            headers_size,
            body_kind,
            content_type,
            content_encoding,
            truncated,
            request,
            warnings,
            timings,
            cookies,
            tests: Vec::new(),
            logs: Vec::new(),
        },
        body,
    })
}
