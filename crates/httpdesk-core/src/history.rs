//! History (GLOSSARY, ADR-0009): the Exchanges sent from a tab, kept on disk outside
//! the workspace, in one SQLite file for every workspace, each entry under its
//! workspace's canonical path.
//!
//! A send is recorded in two steps, like a Session exchange: [`Pending::begin`]
//! before it, with what only the request knows (its file, `# @name`, method and URL
//! as written, its source text), and [`Pending::finish`] after it, with what went
//! out ([`send::Attempt`]) and what came back. A send that put nothing on the wire
//! (blocked) gives no entry. Credentials are masked ([`Masking`]) before the entry
//! exists, so nothing unmasked reaches the [`Store`]. Responses are kept as received.
//!
//! The shell decides which sends are recorded (only a tab's: `send_request`) and
//! writes off the main thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::exec::{ExecError, HttpResponse, SentRequest};
use crate::send::{Attempt, Outgoing, Sent};
use crate::vars::MASK;

/// The store's file name in the config folder.
pub const FILE_NAME: &str = "history.sqlite3";

/// The request headers whose values are always masked: they carry credentials.
const CREDENTIAL_HEADERS: [&str; 3] = ["authorization", "proxy-authorization", "cookie"];

/// The most entries one list returns when the query doesn't say.
const DEFAULT_LIMIT: u32 = 200;

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("History: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("History: {0}")]
    Io(#[from] std::io::Error),
    #[error("History: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, HistoryError>;

/// What is masked in a recorded request before it is written (ADR-0009): the values
/// of [`CREDENTIAL_HEADERS`]. The one place masking happens.
#[derive(Debug, Default, Clone)]
pub struct Masking {}

impl Masking {
    /// `request` with its credentials replaced by [`MASK`].
    pub fn request(&self, mut request: SentRequest) -> SentRequest {
        for (name, value) in &mut request.headers {
            if CREDENTIAL_HEADERS.iter().any(|c| name.eq_ignore_ascii_case(c)) {
                *value = MASK.to_string();
            }
        }
        request
    }
}

/// How a recorded send ended.
pub enum Finished<'a> {
    Sent(&'a Sent),
    Failed(&'a ExecError),
    Cancelled,
}

/// A send from a tab under way, to record once it finishes (see the module docs).
#[derive(Debug, Clone)]
pub struct Pending {
    workspace: PathBuf,
    file: Option<String>,
    name: Option<String>,
    method: String,
    url: String,
    source: String,
    at: DateTime<Utc>,
    started: Instant,
}

impl Pending {
    /// Starts recording the send of `out` from a tab in workspace `root`, now. `None`
    /// with no workspace: History is kept per workspace.
    pub fn begin(root: Option<&Path>, out: &Outgoing) -> Option<Pending> {
        let root = root?;
        let request = &out.request;
        Some(Pending {
            workspace: root.to_path_buf(),
            file: out.file_path.as_deref().map(|f| relative(root, f)),
            name: request.request_name().map(str::to_string),
            method: request.method.clone(),
            url: request.url.clone(),
            source: crate::serializer::request_text(request),
            at: Utc::now(),
            started: Instant::now(),
        })
    }

    /// The entry for the send once it has `finished`, with what `attempt` saw go out,
    /// masked by `masking`. `None` when nothing went out: the send was blocked.
    pub fn finish(self, attempt: &Attempt, finished: Finished<'_>, masking: &Masking) -> Option<NewEntry> {
        let elapsed = self.started.elapsed();
        let outcome = match finished {
            Finished::Sent(sent) => {
                // The response carries the request too: masked there as well.
                let mut response = sent.response.clone();
                response.request = masking.request(response.request);
                return Some(NewEntry {
                    pending: self,
                    elapsed,
                    request: response.request.clone(),
                    outcome: Outcome::Response { response: Box::new(response), body: sent.body.clone() },
                });
            }
            // Refused before the network, though after the attempt was noted.
            Finished::Failed(ExecError::InvalidMethod(_) | ExecError::InvalidHeader(_)) => return None,
            Finished::Failed(e) => Outcome::Failed(serde_json::to_value(e).ok()?),
            Finished::Cancelled => Outcome::Cancelled,
        };
        Some(NewEntry { pending: self, elapsed, request: masking.request(attempt.request()?), outcome })
    }
}

/// `path` relative to `root`, with `/` separators.
fn relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

enum Outcome {
    Response {
        response: Box<HttpResponse>,
        body: Arc<[u8]>,
    },
    /// The send's error, as the webview gets it (`{kind, message, details}`).
    Failed(Value),
    Cancelled,
}

/// A finished send, masked, ready to be written ([`Store::record`]).
pub struct NewEntry {
    pending: Pending,
    elapsed: Duration,
    request: SentRequest,
    outcome: Outcome,
}

/// Which entries to list: the workspace's, or one request's, newest first, a page at a
/// time, narrowed by status class and text.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    /// Only this request's entries.
    pub request: Option<RequestLink>,
    /// Only the entries in this status class.
    pub status: Option<StatusClass>,
    /// Only the entries whose method, URL as sent, file or `# @name` contain this,
    /// ignoring (ASCII) case.
    pub text: Option<String>,
    pub offset: u32,
    pub limit: Option<u32>,
}

/// A status class to list: the responses with a 2xx … 5xx status, or the sends that
/// got no response (a send error or a cancel).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum StatusClass {
    #[serde(rename = "2xx")]
    Success,
    #[serde(rename = "3xx")]
    Redirection,
    #[serde(rename = "4xx")]
    ClientError,
    #[serde(rename = "5xx")]
    ServerError,
    #[serde(rename = "error")]
    NoResponse,
}

impl StatusClass {
    /// The hundreds digit of its statuses (`status / 100`); `None` for no response.
    fn hundreds(self) -> Option<i64> {
        match self {
            StatusClass::Success => Some(2),
            StatusClass::Redirection => Some(3),
            StatusClass::ClientError => Some(4),
            StatusClass::ServerError => Some(5),
            StatusClass::NoResponse => None,
        }
    }
}

/// A `LIKE` pattern (with `ESCAPE '\'`) for text containing `text`.
fn containing(text: &str) -> String {
    format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// What links an entry to its request: its file and `# @name`, or for an unnamed
/// request its file, method and URL as written. A named request keeps its History
/// when its URL changes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLink {
    /// The request's file (absolute, as the webview has it).
    pub file_path: PathBuf,
    pub name: Option<String>,
    pub method: String,
    pub url: String,
}

/// One History entry as a list shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: i64,
    /// When it was sent (RFC 3339, UTC).
    pub time: String,
    /// The request's file, relative to the workspace.
    pub file: Option<String>,
    /// The request's `# @name`.
    pub name: Option<String>,
    /// The method and URL as sent (resolved).
    pub method: String,
    pub url: String,
    /// `None` when no response came back.
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub duration_ms: f64,
    /// The response body's size.
    pub size: Option<i64>,
    /// Why no response came back (the send error's message).
    pub error: Option<String>,
    pub cancelled: bool,
}

/// One History entry, whole: what [`Store::get`] reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub summary: Summary,
    /// The request's text in its file at send time.
    pub source: String,
    /// The request as sent, masked.
    pub request: SentRequest,
    /// The response, under a new id each time it's read, so each read is a
    /// response of its own (ADR-0006).
    pub response: Option<HttpResponse>,
    /// The response body.
    #[serde(skip)]
    pub body: Option<Arc<[u8]>>,
    /// Why no response came back: the send error, as the webview gets it.
    pub send_error: Option<Value>,
}

/// The History store: one SQLite file for every workspace.
pub struct Store {
    conn: Connection,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    workspace TEXT NOT NULL,
    file TEXT,
    name TEXT,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    sent_method TEXT NOT NULL,
    sent_url TEXT NOT NULL,
    status INTEGER,
    status_text TEXT,
    size INTEGER,
    error TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0,
    request TEXT NOT NULL,
    source TEXT NOT NULL,
    response TEXT,
    body BLOB,
    stored_size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_name ON entries (workspace, file, name, time_ms);
CREATE INDEX IF NOT EXISTS entries_by_time ON entries (workspace, time_ms);
CREATE INDEX IF NOT EXISTS entries_by_class ON entries (workspace, status / 100, time_ms);
PRAGMA user_version = 1;
";

/// The columns a [`Summary`] reads, in [`summary`]'s order.
const SUMMARY_COLUMNS: &str =
    "id, time_ms, file, name, sent_method, sent_url, status, status_text, duration_ms, size, error, cancelled";

impl Store {
    /// Opens the store at `path`, creating it (and its folder) if needed.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    /// Writes `entry`; returns its id.
    pub fn record(&self, entry: &NewEntry) -> Result<i64> {
        let p = &entry.pending;
        let request = serde_json::to_string(&entry.request)?;
        let (status, status_text, size, error, cancelled, response, body) = match &entry.outcome {
            Outcome::Response { response, body } => (
                Some(response.status),
                Some(response.status_text.clone()),
                Some(response.body_size as i64),
                None,
                false,
                Some(serde_json::to_string(&HttpResponse { id: String::new(), ..(**response).clone() })?),
                Some(zstd::encode_all(&body[..], 3)?),
            ),
            Outcome::Failed(e) => (None, None, None, Some(e.to_string()), false, None, None),
            Outcome::Cancelled => (None, None, None, None, true, None, None),
        };
        let stored_size = request.len()
            + p.source.len()
            + response.as_ref().map_or(0, String::len)
            + body.as_ref().map_or(0, Vec::len);
        self.conn.execute(
            "INSERT INTO entries (workspace, file, name, method, url, time_ms, duration_ms, sent_method, sent_url,
                status, status_text, size, error, cancelled, request, source, response, body, stored_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                workspace_key(&p.workspace),
                p.file,
                p.name,
                p.method,
                p.url,
                p.at.timestamp_millis(),
                match &entry.outcome {
                    Outcome::Response { response, .. } => response.time_ms,
                    _ => entry.elapsed.as_secs_f64() * 1000.0,
                },
                entry.request.method,
                entry.request.url,
                status,
                status_text,
                size,
                error,
                cancelled,
                request,
                p.source,
                response,
                body,
                stored_size as i64,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Workspace `root`'s entries that `query` asks for, newest first. The request and
    /// the status class are indexed conditions (`entries_by_name`, `entries_by_class`);
    /// text narrows what they find.
    pub fn list(&self, root: &Path, query: &Query) -> Result<Vec<Summary>> {
        let mut sql = format!("SELECT {SUMMARY_COLUMNS} FROM entries WHERE workspace = ?");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_key(root))];
        if let Some(link) = &query.request {
            args.push(Box::new(relative(root, &link.file_path)));
            sql.push_str(" AND file = ?");
            match &link.name {
                Some(name) => {
                    args.push(Box::new(name.clone()));
                    sql.push_str(" AND name = ?");
                }
                None => {
                    args.push(Box::new(link.method.clone()));
                    args.push(Box::new(link.url.clone()));
                    sql.push_str(" AND name IS NULL AND method = ? AND url = ?");
                }
            }
        }
        if let Some(class) = query.status {
            // Written as `entries_by_class` has it, so the index serves it.
            match class.hundreds() {
                Some(hundreds) => {
                    args.push(Box::new(hundreds));
                    sql.push_str(" AND status / 100 = ?");
                }
                None => sql.push_str(" AND status / 100 IS NULL"),
            }
        }
        if let Some(text) = query.text.as_deref().filter(|t| !t.is_empty()) {
            let columns = ["sent_url", "sent_method", "file", "name"];
            let like: Vec<String> = columns.iter().map(|c| format!("{c} LIKE ? ESCAPE '\\'")).collect();
            sql.push_str(&format!(" AND ({})", like.join(" OR ")));
            args.extend(columns.map(|_| Box::new(containing(text)) as Box<dyn rusqlite::ToSql>));
        }
        sql.push_str(&format!(
            " ORDER BY time_ms DESC, id DESC LIMIT {} OFFSET {}",
            query.limit.unwrap_or(DEFAULT_LIMIT),
            query.offset
        ));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), summary)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Entry `id` of workspace `root`, whole; `None` if there's no such entry.
    pub fn get(&self, root: &Path, id: i64) -> Result<Option<Entry>> {
        let row = self
            .conn
            .query_row(
                &format!(
                    "SELECT {SUMMARY_COLUMNS}, source, request, response, body FROM entries WHERE workspace = ?1 AND id = ?2"
                ),
                params![workspace_key(root), id],
                |row| {
                    let columns: (Option<String>, String, String, Option<String>, Option<Vec<u8>>) =
                        (row.get(10)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?);
                    Ok((summary(row)?, columns))
                },
            )
            .optional()?;
        let Some((summary, (error, source, request, response, body))) = row else { return Ok(None) };
        let mut response: Option<HttpResponse> = response.as_deref().map(serde_json::from_str).transpose()?;
        if let Some(r) = &mut response {
            r.id = uuid::Uuid::new_v4().to_string();
        }
        Ok(Some(Entry {
            summary,
            source,
            request: serde_json::from_str(&request)?,
            response,
            body: body.map(|b| zstd::decode_all(&b[..])).transpose()?.map(Arc::from),
            send_error: error.as_deref().map(serde_json::from_str).transpose()?,
        }))
    }
}

/// What a workspace's entries are kept under: its canonical path.
fn workspace_key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

fn summary(row: &Row) -> rusqlite::Result<Summary> {
    let time_ms: i64 = row.get(1)?;
    let error: Option<String> = row.get(10)?;
    Ok(Summary {
        id: row.get(0)?,
        time: DateTime::<Utc>::from_timestamp_millis(time_ms)
            .unwrap_or_default()
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        file: row.get(2)?,
        name: row.get(3)?,
        method: row.get(4)?,
        url: row.get(5)?,
        status: row.get(6)?,
        status_text: row.get(7)?,
        duration_ms: row.get(8)?,
        size: row.get(9)?,
        error: error.and_then(|e| serde_json::from_str::<Value>(&e).ok()?.get("message")?.as_str().map(str::to_string)),
        cancelled: row.get(11)?,
    })
}
