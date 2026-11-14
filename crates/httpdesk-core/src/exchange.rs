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
use serde::Serialize;

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
    /// The response's status code.
    pub status: u16,
    pub received: DateTime<Utc>,
    /// The response as the viewer showed it, without its body (ADR-0006): what
    /// opening the exchange from the Session panel shows again, with `response.body`.
    pub shown: HttpResponse,
}

impl Exchange {
    /// The response as the viewer showed it, under a new response id, for showing it
    /// again with `response.body` kept under that id.
    pub fn reopened(&self) -> HttpResponse {
        HttpResponse { id: uuid::Uuid::new_v4().to_string(), ..self.shown.clone() }
    }

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

    /// Every latest exchange held (the Session panel's Named exchanges): by file, then name.
    pub fn list(&self) -> Vec<NamedExchange> {
        let mut list: Vec<NamedExchange> = self
            .lock()
            .iter()
            .map(|((file, name), e)| NamedExchange {
                file: file.clone(),
                name: name.clone(),
                status: e.status,
                received: e.received,
            })
            .collect();
        list.sort_by(|a, b| (&a.file, &a.name).cmp(&(&b.file, &b.name)));
        list
    }

    /// What Request variable `reference` (trimmed, without braces) of a request in
    /// `file` reads now, for its hover: unsent, its value (shortened past
    /// [`READING_LIMIT`] characters), or why it matches nothing. `None` when the
    /// reference isn't a Request variable.
    pub fn read(&self, file: &Path, reference: &str) -> Option<Reading> {
        let (name, path) = split_reference(reference)?;
        let request = name.to_string();
        let Some(exchange) = self.latest(file, name) else { return Some(Reading::Unsent { request }) };
        let (status, received) = (exchange.status, exchange.received);
        Some(match exchange.value(path) {
            Ok(value) => Reading::Value { request, status, received, value: shorten(value) },
            Err(reason) => Reading::Unmatched { request, status, received, reason },
        })
    }

    /// Forgets the latest exchange of the request named `name` in `file`, so its
    /// Request variables read as unsent. False if there was none.
    pub fn remove(&self, file: &Path, name: &str) -> bool {
        self.lock().remove(&(file.to_path_buf(), name.to_string())).is_some()
    }

    /// Forgets every exchange, so every Request variable reads as unsent.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(PathBuf, String), Arc<Exchange>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One entry of the Session panel's Named exchanges: a named request with a latest
/// exchange, its file, the response's status and when it arrived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NamedExchange {
    pub file: PathBuf,
    pub name: String,
    pub status: u16,
    /// Serialized as RFC 3339 in UTC, with milliseconds.
    #[serde(serialize_with = "rfc3339")]
    pub received: DateTime<Utc>,
}

fn rfc3339<S: serde::Serializer>(at: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// How many characters of a Request variable's value its hover shows.
pub const READING_LIMIT: usize = 2_000;

fn shorten(value: String) -> String {
    match value.char_indices().nth(READING_LIMIT) {
        Some((at, _)) => format!("{}…", &value[..at]),
        None => value,
    }
}

/// What a Request variable reads now ([`Exchanges::read`]): what its hover shows.
/// Each names the request it reads; the last two say which exchange (its status and
/// when it arrived).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Reading {
    /// The request hasn't been sent in this Session: a send would be blocked.
    Unsent { request: String },
    /// The value a send would insert.
    Value {
        request: String,
        status: u16,
        #[serde(serialize_with = "rfc3339")]
        received: DateTime<Utc>,
        value: String,
    },
    /// The path reads nothing from the exchange (`reason` says why): a send would be blocked.
    Unmatched {
        request: String,
        status: u16,
        #[serde(serialize_with = "rfc3339")]
        received: DateTime<Utc>,
        reason: String,
    },
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
        let (status, shown) = (response.status, response.clone());
        let response = Message { headers: response.headers.clone(), body, content_type: response.content_type.clone() };
        let exchange = Exchange { request: self.request, response, status, received: Utc::now(), shown };
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
