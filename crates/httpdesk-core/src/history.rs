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

use crate::exec::{self, ExecError, HttpResponse, SentRequest};
use crate::send::{self, Attempt, Outgoing, Sent};
use crate::vars::{MaskedValues, MASK};

/// The store's file name in the config folder.
pub const FILE_NAME: &str = "history.sqlite3";

/// The directive (JetBrains `# @no-log`) of a request that is never recorded.
const NO_LOG: &str = "no-log";

/// The request headers whose values are always masked: they carry credentials.
const CREDENTIAL_HEADERS: [&str; 3] = ["authorization", "proxy-authorization", "cookie"];

/// The most entries one list returns when the query doesn't say.
const DEFAULT_LIMIT: u32 = 200;

/// The most of a body an entry keeps, the request's and the response's: 10 MB. A
/// text body over it is kept cut off; a binary response body over it isn't kept.
pub const BODY_CAP: usize = 10 * 1024 * 1024;

/// How much of its response body an entry kept (see [`BODY_CAP`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BodyKept {
    /// All of it (or there's no response).
    #[default]
    Whole,
    /// A text body over the cap: its first [`BODY_CAP`] bytes.
    Truncated,
    /// A binary body over the cap: none of it, only the response's headers and size.
    HeadersOnly,
}

/// The first [`BODY_CAP`] bytes of `body`, cut back to the start of a UTF-8
/// character so a text body doesn't end in half of one.
fn capped(body: &[u8]) -> &[u8] {
    if body.len() <= BODY_CAP {
        return body;
    }
    let mut end = BODY_CAP;
    while end > BODY_CAP - 3 && body[end] & 0xC0 == 0x80 {
        end -= 1;
    }
    &body[..end]
}

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
/// of [`CREDENTIAL_HEADERS`], and every Secret value and prompt answer the send used
/// (as the send resolved them: [`send::RequestScope::masked_values`]), wherever it
/// shows. The one place masking happens.
struct Masking {
    values: MaskedValues,
}

impl Masking {
    /// `request` with its credential headers and every masked value in its URL,
    /// headers and body replaced by [`MASK`].
    fn request(&self, mut request: SentRequest) -> SentRequest {
        request.url = self.values.mask(&request.url);
        for (name, value) in &mut request.headers {
            *value = match CREDENTIAL_HEADERS.iter().any(|c| name.eq_ignore_ascii_case(c)) {
                true => MASK.to_string(),
                false => self.values.mask(value),
            };
        }
        request.body_preview = request.body_preview.map(|body| self.values.mask(&body));
        request
    }

    /// `value` (a send error) with every masked value in its text replaced: it can
    /// quote the URL.
    fn error(&self, value: Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.values.mask(&s)),
            Value::Array(items) => Value::Array(items.into_iter().map(|v| self.error(v)).collect()),
            Value::Object(fields) => Value::Object(fields.into_iter().map(|(k, v)| (k, self.error(v))).collect()),
            other => other,
        }
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
    /// with no workspace (History is kept per workspace), and for a request marked
    /// `# @no-log`, which is never recorded (honoured like `# @no-cookie-jar`).
    pub fn begin(root: Option<&Path>, out: &Outgoing) -> Option<Pending> {
        let root = root?;
        let request = &out.request;
        if request.directive(NO_LOG).is_some() {
            return None;
        }
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

    /// The entry for the send once it has `finished`, with what `attempt` (made
    /// [`Attempt::for_history`]) saw go out, masked. `None` when nothing went out (the
    /// send was blocked), or the attempt wasn't made for History. The request keeps
    /// its body up to [`BODY_CAP`], more than the request as sent shows.
    pub fn finish(self, attempt: &Attempt, finished: Finished<'_>) -> Option<NewEntry> {
        let elapsed = self.started.elapsed();
        let send::ForHistory { body, masked } = attempt.take_for_history()?;
        let masking = &Masking { values: masked };
        let request = |mut request: SentRequest| {
            if let (Some(_), Some(body)) = (&request.body_preview, &body) {
                let kept = capped(body);
                request.body_truncated = kept.len() < request.body_size;
                request.body_preview = Some(String::from_utf8_lossy(kept).into_owned());
            }
            masking.request(request)
        };
        let outcome = match finished {
            Finished::Sent(sent) => {
                // The response carries the request too, and the URL it was sent to:
                // masked there as well.
                let mut response = sent.response.clone();
                response.request = request(response.request);
                response.url = masking.values.mask(&response.url);
                return Some(NewEntry {
                    pending: self,
                    elapsed,
                    request: response.request.clone(),
                    outcome: Outcome::Response { response: Box::new(response), body: sent.body.clone() },
                });
            }
            // Refused before the network, though after the attempt was noted.
            Finished::Failed(ExecError::InvalidMethod(_) | ExecError::InvalidHeader(_)) => return None,
            Finished::Failed(e) => Outcome::Failed(masking.error(serde_json::to_value(e).ok()?)),
            Finished::Cancelled => Outcome::Cancelled,
        };
        Some(NewEntry { pending: self, elapsed, request: request(attempt.request()?), outcome })
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
    /// The response body, up to [`BODY_CAP`].
    #[serde(skip)]
    pub body: Option<Arc<[u8]>>,
    /// How much of the response body was kept.
    pub body_kept: BodyKept,
    /// Why no response came back: the send error, as the webview gets it.
    pub send_error: Option<Value>,
}

/// How much History is kept (Settings → History), for every workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    /// The most entries one request keeps in its workspace (see [`RequestLink`]).
    pub per_request: u32,
    /// How many days an entry is kept.
    pub max_age_days: u32,
    /// The most bytes every workspace's entries take together.
    pub max_size: u64,
}

/// What an entry's request is, as [`RequestLink`] links them: its workspace, file
/// and `# @name`, and for an unnamed request its method and URL as written. Two
/// entries are of the same request when these are the same (compared as a row value
/// with `IS`, as the file and name may be NULL). The one place the rule is written:
/// listing a request's entries and retention's count per request both use it.
const REQUEST: &str =
    "workspace, file, name, CASE WHEN name IS NULL THEN method END, CASE WHEN name IS NULL THEN url END";

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
CREATE INDEX IF NOT EXISTS entries_by_age ON entries (time_ms);
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
                // Its request is the entry's: kept once, in `request`.
                Some(serde_json::to_string(&HttpResponse {
                    id: String::new(),
                    request: SentRequest::default(),
                    ..(**response).clone()
                })?),
                match body.len() > BODY_CAP && !response.body_kind.is_text() {
                    true => None,
                    false => Some(zstd::encode_all(capped(body), 3)?),
                },
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
            let unnamed = link.name.is_none();
            sql.push_str(&format!(" AND ({REQUEST}) IS (?, ?, ?, ?, ?)"));
            args.push(Box::new(workspace_key(root)));
            args.push(Box::new(relative(root, &link.file_path)));
            args.push(Box::new(link.name.clone()));
            args.push(Box::new(unnamed.then(|| link.method.clone())));
            args.push(Box::new(unnamed.then(|| link.url.clone())));
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

    /// Removes what `retention` doesn't keep: each request's oldest entries past its
    /// count, entries past the age limit, and, while every workspace's entries
    /// together take more than the size cap, the oldest of them. With `after`, the
    /// entry just recorded, only that entry's request is counted; otherwise every
    /// request is (the limits changed).
    pub fn trim(&self, retention: &Retention, after: Option<i64>) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        match after {
            Some(id) => tx.execute(
                &format!(
                    "DELETE FROM entries WHERE id IN (
                        SELECT id FROM entries WHERE ({REQUEST}) IS (SELECT {REQUEST} FROM entries WHERE id = ?1)
                        ORDER BY time_ms DESC, id DESC LIMIT -1 OFFSET ?2)"
                ),
                params![id, retention.per_request],
            )?,
            None => tx.execute(
                &format!(
                    "DELETE FROM entries WHERE id IN (SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY {REQUEST} ORDER BY time_ms DESC, id DESC) AS n
                        FROM entries) WHERE n > ?1)"
                ),
                params![retention.per_request],
            )?,
        };
        let oldest = Utc::now() - chrono::Duration::days(i64::from(retention.max_age_days));
        tx.execute("DELETE FROM entries WHERE time_ms < ?1", params![oldest.timestamp_millis()])?;
        let total: i64 = tx.query_row("SELECT COALESCE(SUM(stored_size), 0) FROM entries", [], |r| r.get(0))?;
        if total as u64 > retention.max_size {
            // Keeps the newest entries that fit together.
            tx.execute(
                "DELETE FROM entries WHERE id IN (SELECT id FROM (
                    SELECT id, SUM(stored_size) OVER (ORDER BY time_ms DESC, id DESC) AS kept FROM entries)
                    WHERE kept > ?1)",
                params![retention.max_size as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Deletes entry `id` of workspace `root`, and the space it took on disk.
    pub fn delete(&self, root: &Path, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM entries WHERE workspace = ?1 AND id = ?2", params![workspace_key(root), id])?;
        self.compact()
    }

    /// Deletes every entry of workspace `root`, and the space they took on disk.
    pub fn clear_workspace(&self, root: &Path) -> Result<()> {
        self.conn.execute("DELETE FROM entries WHERE workspace = ?1", params![workspace_key(root)])?;
        self.compact()
    }

    /// Deletes every entry of every workspace, and the space they took on disk, so
    /// nothing of them can be read back from the file.
    pub fn clear_all(&self) -> Result<()> {
        self.conn.execute("DELETE FROM entries", [])?;
        self.compact()
    }

    /// Rewrites the file without the space deleted entries left, then empties the
    /// journal (WAL) of what it still held of them.
    fn compact(&self) -> Result<()> {
        self.conn.execute_batch("VACUUM")?;
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
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
        let request = previewed(serde_json::from_str(&request)?);
        let mut response: Option<HttpResponse> = response.as_deref().map(serde_json::from_str).transpose()?;
        if let Some(r) = &mut response {
            r.id = uuid::Uuid::new_v4().to_string();
            r.request = request.clone();
        }
        let body: Option<Arc<[u8]>> = body.map(|b| zstd::decode_all(&b[..])).transpose()?.map(Arc::from);
        let body_kept = match (&response, &body) {
            (Some(_), None) => BodyKept::HeadersOnly,
            (Some(r), Some(b)) if b.len() < r.body_size => BodyKept::Truncated,
            _ => BodyKept::Whole,
        };
        Ok(Some(Entry {
            summary,
            source,
            request,
            response,
            body,
            body_kept,
            send_error: error.as_deref().map(serde_json::from_str).transpose()?,
        }))
    }
}

/// `request` (as stored: its body masked, up to [`BODY_CAP`], and `body_truncated`
/// when the cap cut it) with its body as the live send's reply shows it
/// ([`exec::body_preview`]): a read never carries megabytes of it (ADR-0006). Whether
/// the preview stops short, and so says how many bytes were sent, goes by the stored
/// body, which masking may have made shorter or longer than the one sent.
fn previewed(mut request: SentRequest) -> SentRequest {
    if let Some(body) = request.body_preview.take() {
        request.body_preview = Some(exec::body_preview(body.as_bytes(), request.body_size));
    }
    request
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
