//! Exchanges: what a named request sent and got back, which its file's Request
//! variables read (`{{login.response.body.$.token}}`, VS Code REST Client syntax).
//!
//! Every send of a request with `# @name x` records its exchange as the latest for
//! `x` in its file, in the Session's [`Exchanges`]. An exchange keeps the full body
//! sent and its own reference to the body received, so it outlives the response
//! the viewer shows. Only `# @name` names count, never `###` text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use chrono::{DateTime, Local, Utc};

use crate::exec::{decode_text, HttpResponse, PreparedRequest};
use crate::json_filter::JsonDocument;
use crate::model::Request;

/// One side of an exchange: its headers and complete body.
#[derive(Debug, Clone)]
pub struct Message {
    pub headers: Vec<(String, String)>,
    pub body: Arc<[u8]>,
    pub content_type: Option<String>,
}

impl Message {
    /// The values of header `name` (matched case-insensitively), joined with `, `.
    /// `None` when there is no such header.
    pub fn header(&self, name: &str) -> Option<String> {
        let values: Vec<&str> =
            self.headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).collect();
        (!values.is_empty()).then(|| values.join(", "))
    }

    /// The body as text: in its charset, else UTF-8 (invalid bytes replaced).
    pub fn text(&self) -> String {
        decode_text(&self.body, self.content_type.as_deref())
            .unwrap_or_else(|| String::from_utf8_lossy(&self.body).into_owned())
    }
}

/// A named request's send: the request as sent, the response, and when it arrived.
#[derive(Debug, Clone)]
pub struct Exchange {
    /// The request as prepared and sent: its headers (the default ones included) and full body.
    pub request: Message,
    pub response: Message,
    pub received: DateTime<Utc>,
}

impl Exchange {
    /// The value a Request variable's `path` (what follows `name.`, such as
    /// `response.body.$.token`) reads from this exchange, or why it reads nothing.
    pub fn value(&self, path: &str) -> Result<String, String> {
        let (side, rest) = path.split_once('.').unwrap_or((path, ""));
        let message = match side {
            "response" => &self.response,
            "request" => &self.request,
            _ => return Err(format!("`{side}` is neither `response` nor `request`")),
        };
        match rest.split_once('.') {
            Some(("body", path)) => body_value(message, path),
            Some(("headers", name)) => message.header(name).ok_or_else(|| format!("there is no `{name}` header")),
            _ => Err(format!("it should go on with `{side}.body.…` or `{side}.headers.…`")),
        }
    }
}

/// What body path `path` reads from `message`: `*` the whole body, `$…` the first
/// value that JSONPath matches. Every body path goes through here, so other kinds
/// of body (by content type) plug in at one place.
fn body_value(message: &Message, path: &str) -> Result<String, String> {
    if path == "*" {
        return Ok(message.text());
    }
    if !path.starts_with('$') {
        return Err(format!("`{path}` is neither `*` nor a JSONPath starting with `$`"));
    }
    let doc = JsonDocument::parse(&message.text()).map_err(|e| e.to_string())?;
    doc.first(path).map_err(|e| e.to_string())?.ok_or_else(|| format!("`{path}` matches nothing"))
}

/// For a `{{…}}` reference (trimmed, without braces): the request name and the path
/// after it when it is a Request variable (`name.response…` or `name.request…`).
/// A Request variable never falls back to a variable of the same name.
pub(crate) fn split_reference(reference: &str) -> Option<(&str, &str)> {
    let (name, path) = reference.split_once('.')?;
    let side = path.split('.').next().unwrap_or("");
    let named = !name.is_empty() && !name.starts_with('$') && !name.contains(char::is_whitespace);
    (named && matches!(side, "response" | "request")).then_some((name, path))
}

/// The `# @name`s of one file, each with its latest exchange in the Session (`None`
/// when it hasn't been sent): what that file's Request variables can read.
pub type NamedExchanges = HashMap<String, Option<Arc<Exchange>>>;

/// The Session's latest exchange of each named request, per file.
#[derive(Debug, Default)]
pub struct Exchanges(Mutex<HashMap<(PathBuf, String), Arc<Exchange>>>);

impl Exchanges {
    /// The latest exchange of the request named `name` in `file`, if it was sent.
    pub fn latest(&self, file: &Path, name: &str) -> Option<Arc<Exchange>> {
        self.lock().get(&(file.to_path_buf(), name.to_string())).cloned()
    }

    /// Each of `names` (the file's `# @name`s) with its latest exchange in `file`.
    pub fn for_file(&self, file: &Path, names: &[String]) -> NamedExchanges {
        names.iter().map(|n| (n.clone(), self.latest(file, n))).collect()
    }

    /// Makes `exchange` the latest of the request named `name` in `file`. Of two
    /// requests sharing a name, the one sent last supplies it.
    pub fn record(&self, file: &Path, name: &str, exchange: Exchange) {
        self.lock().insert((file.to_path_buf(), name.to_string()), Arc::new(exchange));
    }

    /// Forgets every exchange, so every Request variable reads as unsent.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(PathBuf, String), Arc<Exchange>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A named request's send in flight: the request as it goes out, waiting for its response.
#[derive(Debug)]
pub struct PendingExchange {
    file: PathBuf,
    name: String,
    request: Message,
}

/// Starts recording the send of `request` from `file`, prepared as `prepared`.
/// `None` (nothing to record) unless it has a `# @name` and a file.
pub fn begin(file: Option<&Path>, request: &Request, prepared: &PreparedRequest) -> Option<PendingExchange> {
    let name = request.request_name()?;
    let content_type = prepared.header("content-type").map(str::to_string);
    let body: Arc<[u8]> = prepared.body.as_deref().unwrap_or_default().into();
    Some(PendingExchange {
        file: file?.to_path_buf(),
        name: name.to_string(),
        request: Message { headers: prepared.headers.clone(), body, content_type },
    })
}

impl PendingExchange {
    /// Records the exchange, with `response` and its `body`, as the latest of its
    /// request in `exchanges`, received now.
    pub fn finish(self, exchanges: &Exchanges, response: &HttpResponse, body: Arc<[u8]>) {
        let response = Message { headers: response.headers.clone(), body, content_type: response.content_type.clone() };
        let exchange = Exchange { request: self.request, response, received: Utc::now() };
        exchanges.record(&self.file, &self.name, exchange);
    }
}

/// A Request variable whose path reads nothing from its request's latest exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmatchedPath {
    /// The reference as written between the braces, trimmed: `login.response.body.$.tok`.
    pub reference: String,
    /// The `# @name` of the request whose exchange it looked in.
    pub request: String,
    /// When that exchange's response arrived.
    pub received: DateTime<Utc>,
    /// Why it reads nothing: `` `$.tok` matches nothing ``.
    pub reason: String,
}

impl std::fmt::Display for UnmatchedPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let at = self.received.with_timezone(&Local).format("%H:%M:%S");
        write!(
            f,
            "{{{{{}}}}}: {}, in the latest exchange of `{}` (received at {at})",
            self.reference, self.reason, self.request
        )
    }
}
