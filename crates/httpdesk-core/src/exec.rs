//! Request execution. [`prepare`] turns a model [`Request`] into the exact bytes
//! to send (applying variables and dropping disabled components). [`execute`]
//! sends it with reqwest.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::cookies::{self, ResponseCookie};
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
    /// Unresolved variables in the URL's scheme or host.
    #[error("The URL's scheme or host uses undefined variables: {}. Pick an environment that defines them, or declare them as file variables.", .0.join(", "))]
    UnresolvedHost(Vec<String>),
    #[error("{}", .0.join("\n"))]
    DynamicVariable(Vec<String>),
}

fn human_ms(ms: u64) -> String {
    match ms {
        m if m >= 60_000 && m % 60_000 == 0 => format!("{} min", m / 60_000),
        m if m % 1000 == 0 => format!("{} s", m / 1000),
        m => format!("{m} ms"),
    }
}

impl ExecError {
    /// The class of failure the UI picks a heading, hint and fix-it buttons by.
    pub fn kind(&self) -> &'static str {
        match self {
            ExecError::Dns { .. } => "dns",
            ExecError::Refused { .. } => "refused",
            ExecError::Reset { .. } => "reset",
            ExecError::ReadTimeout(_) => "timeoutIdle",
            ExecError::ConnectTimeout(_) => "timeoutConnect",
            ExecError::InvalidUrl { .. } => "invalidUrl",
            ExecError::UnresolvedHost(_) => "unresolvedVariable",
            ExecError::File { .. } => "file",
            ExecError::Tls(_) | ExecError::TlsHandshake { .. } => "tls",
            ExecError::InvalidMethod(_)
            | ExecError::InvalidHeader(_)
            | ExecError::DynamicVariable(_)
            | ExecError::Other(_) => "other",
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
        st.serialize_field("kind", self.kind())?;
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

/// `< path` (raw) or `<@ path` (variables substituted). `None` if not a file reference.
fn file_reference(line: &str, resolver: &Resolver, base_dir: &Path) -> Option<Result<Vec<u8>, ExecError>> {
    let crate::parser::FileReference { substitute, path } = crate::parser::file_reference(line)?;
    let path = resolver.resolve(path);
    Some(read_file(base_dir, &path).map(|bytes| {
        if substitute {
            resolver.resolve(&String::from_utf8_lossy(&bytes)).into_bytes()
        } else {
            bytes
        }
    }))
}

fn build_body(body: &Body, resolver: &Resolver, base_dir: &Path) -> Result<Option<Vec<u8>>, ExecError> {
    if !body.enabled || !body.is_present() {
        return Ok(None);
    }
    let text = body.text.trim_end();
    if !text.contains('\n') {
        if let Some(file) = file_reference(text, resolver, base_dir) {
            return file.map(Some);
        }
    }
    let bytes = match body.mode {
        BodyMode::Multipart => {
            let mut out = Vec::new();
            // `#~` lines are disabled parts (see the parser).
            for line in text.lines().filter(|l| !l.starts_with(DISABLED_MARKER)) {
                match file_reference(line, resolver, base_dir) {
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

/// Resolves variables and applies enablement. Disabled components are never included.
pub fn prepare(
    req: &Request,
    resolver: &Resolver,
    base_dir: &Path,
    settings: &ExecSettings,
) -> Result<PreparedRequest, ExecError> {
    let method = req.method.trim().to_ascii_uppercase();
    let method = if method.is_empty() { "GET".to_string() } else { method };

    // Headers
    let mut headers: Vec<(String, String)> = Vec::new();
    let auth = &req.auth;
    if auth.enabled {
        match auth.kind {
            AuthKind::Basic => {
                let creds = format!("{}:{}", resolver.resolve(&auth.username), resolver.resolve(&auth.password));
                headers.push((
                    "Authorization".into(),
                    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(creds)),
                ));
            }
            AuthKind::Bearer => {
                headers.push(("Authorization".into(), format!("Bearer {}", resolver.resolve(auth.token.trim()))))
            }
            AuthKind::ApiKey if auth.key_location == ApiKeyLocation::Header && !auth.key_name.is_empty() => {
                headers.push((auth.key_name.clone(), resolver.resolve(&auth.key_value)));
            }
            _ => {}
        }
    }
    headers.extend(req.headers.active().map(|h| (resolver.resolve(&h.name), resolver.resolve(&h.value))));

    // URL
    let mut url = resolver.resolve(req.url.trim());
    let auto_encode = req.directive("no-auto-encoding").is_none();
    let mut params: Vec<String> = req.query.active().map(|p| wire_param(p, resolver, auto_encode)).collect();
    if auth.enabled
        && auth.kind == AuthKind::ApiKey
        && auth.key_location == ApiKeyLocation::Query
        && !auth.key_name.is_empty()
    {
        params.push(wire_param(&KeyValue::new(&auth.key_name, &auth.key_value), resolver, auto_encode));
    }
    if !params.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&params.join("&"));
    }
    if !has_scheme(&url) {
        url = if url.starts_with('/') {
            let host =
                headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("host")).map(|(_, v)| v.clone()).ok_or_else(
                    || ExecError::InvalidUrl { url: url.clone(), reason: "relative URL needs a Host header".into() },
                )?;
            format!("http://{host}{url}")
        } else {
            format!("http://{url}")
        };
    }
    dynamic_errors(resolver)?;
    let host_vars = variable_names(origin(&url));
    if !host_vars.is_empty() {
        return Err(ExecError::UnresolvedHost(host_vars));
    }
    url::Url::parse(&url).map_err(|e| ExecError::InvalidUrl { url: url.clone(), reason: e.to_string() })?;

    // Body
    let body = build_body(&req.body, resolver, base_dir)?;
    dynamic_errors(resolver)?;
    if body.is_some() && !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("content-type")) {
        if let Some(ct) = default_content_type(req.body.mode) {
            headers.push(("Content-Type".into(), ct.into()));
        }
    }
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("user-agent")) {
        headers.push(("User-Agent".into(), concat!("HttpDesk/", env!("CARGO_PKG_VERSION")).into()));
    }
    // Added here rather than by reqwest so the Request tab shows it.
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("accept-encoding")) {
        headers.push(("Accept-Encoding".into(), DEFAULT_ACCEPT_ENCODING.into()));
    }

    let mut warnings = Vec::new();
    let unresolved = resolver.unresolved();
    if !unresolved.is_empty() {
        warnings.push(format!("Unresolved variables: {}", unresolved.join(", ")));
    }
    if req.body.enabled && req.body.mode == BodyMode::Multipart {
        let ct =
            headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.as_str()).unwrap_or("");
        if !ct.contains("boundary=") {
            warnings.push("Multipart body without a boundary in Content-Type".into());
        }
    }

    let timeout_ms = req.directive("timeout").and_then(parse_duration_ms).unwrap_or(settings.timeout_ms);
    let connect_timeout_ms =
        req.directive("connection-timeout").and_then(parse_duration_ms).unwrap_or(settings.connect_timeout_ms);
    let follow_redirects = settings.follow_redirects && req.directive("no-redirect").is_none();

    Ok(PreparedRequest { method, url, headers, body, follow_redirects, timeout_ms, connect_timeout_ms, warnings })
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
    /// The response's `Content-Encoding` header, as sent by the server.
    pub content_encoding: Option<String>,
    /// Decoded text for textual content types.
    pub body_text: Option<String>,
    /// Base64 for binary content (only below the preview limit).
    pub body_base64: Option<String>,
    pub truncated: bool,
    pub request: SentRequest,
    pub warnings: Vec<String>,
    /// Every `Set-Cookie` received, redirect hops first, each with the URL
    /// that set it. Shown only; never sent back.
    pub cookies: Vec<ResponseCookie>,
}

pub struct ExecOutcome {
    pub response: HttpResponse,
    /// The complete (possibly truncated) body, for "save to file".
    pub body: Vec<u8>,
}

const BINARY_PREVIEW_LIMIT: usize = 25 * 1024 * 1024;

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
                let found = crate::tls_probe::certificate_reason(&host, port, timeout).await;
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

fn build_client(
    p: &PreparedRequest,
    settings: &ExecSettings,
    ssl: &SslConfig,
    cookies: Arc<cookies::Recorder>,
) -> Result<reqwest::Client, ExecError> {
    // Decoding happens in `body` so the raw bytes can be counted. These also
    // guard against another crate enabling reqwest's decompression features.
    let mut b = reqwest::Client::builder()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .cookie_provider(cookies)
        .redirect(if p.follow_redirects {
            reqwest::redirect::Policy::limited(settings.max_redirects)
        } else {
            reqwest::redirect::Policy::none()
        })
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

fn decode_text(bytes: &[u8], content_type: Option<&str>) -> Option<String> {
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

pub async fn execute(p: PreparedRequest, settings: &ExecSettings, ssl: &SslConfig) -> Result<ExecOutcome, ExecError> {
    execute_with_progress(p, settings, ssl, |_| {}).await
}

/// The shortest gap between two progress reports, so a body arriving in many
/// small chunks doesn't flood the UI (at most ~10 reports a second).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// [`execute`], calling `on_progress` with the body bytes received on the wire
/// so far while the body downloads. Reports come at most once per
/// [`PROGRESS_INTERVAL`], each larger than the last, and none after the
/// function returns.
pub async fn execute_with_progress(
    p: PreparedRequest,
    settings: &ExecSettings,
    ssl: &SslConfig,
    mut on_progress: impl FnMut(usize) + Send,
) -> Result<ExecOutcome, ExecError> {
    let cookies = Arc::new(cookies::Recorder::default());
    let client = build_client(&p, settings, ssl, cookies.clone())?;
    let method =
        reqwest::Method::from_bytes(p.method.as_bytes()).map_err(|_| ExecError::InvalidMethod(p.method.clone()))?;
    let mut builder = client.request(method, &p.url);
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

    let start = Instant::now();
    let mut resp = match builder.send().await {
        Ok(resp) => resp,
        Err(e) => return Err(classify(e, &p).await),
    };
    let ttfb = start.elapsed();

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

    // A body that fails to decode is classified `other`, with body.rs's message.
    let (mut reader, unsupported) = body::BodyReader::new(content_encoding.as_deref(), settings.max_body_bytes);
    let as_received = unsupported.is_some();
    let mut last_report: Option<Instant> = None;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(classify(e, &p).await),
        };
        if !reader.push(&chunk).map_err(ExecError::Other)? {
            break;
        }
        // The first chunk reports at once; after that, once per interval.
        if last_report.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) && !chunk.is_empty() {
            last_report = Some(Instant::now());
            on_progress(reader.transferred());
        }
    }
    let body::ReceivedBody { bytes: body, transferred, truncated } = reader.finish().map_err(ExecError::Other)?;
    let elapsed = start.elapsed();
    let mut warnings = p.warnings;
    warnings.extend(unsupported);

    // Still-encoded bytes are binary whatever the content type says.
    let body_text = if as_received { None } else { decode_text(&body, content_type.as_deref()) };
    let body_base64 = (body_text.is_none() && body.len() <= BINARY_PREVIEW_LIMIT)
        .then(|| base64::engine::general_purpose::STANDARD.encode(&body));

    let request = SentRequest {
        method: p.method.clone(),
        url: p.url.clone(),
        headers: p.headers.clone(),
        body_size: p.body.as_ref().map_or(0, Vec::len),
        body_preview: p.body.as_ref().map(|b| {
            let s = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).into_owned();
            if b.len() > 64 * 1024 {
                format!("{s}\n… ({} bytes total)", b.len())
            } else {
                s
            }
        }),
    };

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
            content_type,
            content_encoding,
            body_text,
            body_base64,
            truncated,
            request,
            warnings,
            cookies: cookies.take(),
        },
        body,
    })
}
