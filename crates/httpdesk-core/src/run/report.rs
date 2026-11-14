//! What a Run reports about each of its requests when it ends (see [`super::run`]),
//! for an export to read: where the request is, what was sent, and how it went. No
//! response body, and every Secret value masked.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::exec::{ErrorKind, ExecError, HttpResponse};
use crate::script::TestResult;
use crate::send::Outgoing;
use crate::vars::MASK;

/// One request of a Run, as an export shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestReport {
    /// Its file, from the workspace root with `/` between folders; `None` for a request in no file.
    pub file: Option<String>,
    pub name: String,
    pub method: String,
    /// The URL as sent, each Secret value masked; `None` when it wasn't sent.
    pub url: Option<String>,
    pub status: Option<u16>,
    pub time_ms: Option<f64>,
    pub outcome: Outcome,
    /// Why it failed, when it did (GLOSSARY "Run").
    pub failure: Option<Failure>,
    /// Its scripts' `client.test` and `client.assert` results, in order.
    pub tests: Vec<TestResult>,
}

/// How a request of a Run went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Passed,
    /// See [`Failure`].
    Failed,
    /// The run was stopped while it was being sent.
    Cancelled,
    /// The run was stopped before it.
    NotRun,
}

/// Why a request of a Run failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub reason: Reason,
    pub message: String,
}

/// The kinds of failure GLOSSARY "Run" names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// No response: the host didn't resolve or answer, the connection failed or timed out.
    Network,
    /// A pre-request script or response handler threw or ran out of time or memory.
    Script,
    /// A `client.test` or `client.assert` failed.
    Test,
    /// It couldn't be sent as it is (an undefined host, an untrusted script, an unsent
    /// Request variable…).
    Blocked,
}

impl Reason {
    /// Its name in an export.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Network => "network",
            Reason::Script => "script",
            Reason::Test => "test",
            Reason::Blocked => "blocked",
        }
    }
}

impl RequestReport {
    /// `out` before it's sent: as a request the run never reached reports it.
    pub(crate) fn not_run(root: Option<&Path>, out: &Outgoing) -> Self {
        RequestReport {
            file: out.file_path.as_deref().map(|p| file_label(root, p)),
            name: out.request.display_name(),
            method: out.request.method.to_uppercase(),
            url: None,
            status: None,
            time_ms: None,
            outcome: Outcome::NotRun,
            failure: None,
            tests: Vec::new(),
        }
    }

    /// It got `response`, and `failed` per [`super::failed`].
    pub(crate) fn sent(&mut self, response: &HttpResponse, failed: bool, secrets: &Secrets) {
        self.method = response.request.method.clone();
        self.url = Some(secrets.mask(&response.request.url));
        self.status = Some(response.status);
        self.time_ms = Some(response.time_ms);
        self.tests = response
            .tests
            .iter()
            .map(|t| TestResult {
                name: secrets.mask(&t.name),
                passed: t.passed,
                message: t.message.as_deref().map(|m| secrets.mask(m)),
                script_error: t.script_error,
            })
            .collect();
        self.outcome = if failed { Outcome::Failed } else { Outcome::Passed };
        self.failure = failed.then(|| {
            let failing: Vec<&TestResult> = self.tests.iter().filter(|t| !t.passed).collect();
            let script = failing.iter().any(|t| t.script_error);
            Failure {
                reason: if script { Reason::Script } else { Reason::Test },
                message: failing.iter().map(|t| test_failure(t)).collect::<Vec<_>>().join("\n"),
            }
        });
    }

    /// It got no response: `error` blocked it or the network failed.
    pub(crate) fn failed(&mut self, error: &ExecError, secrets: &Secrets) {
        let reason = match error.kind() {
            ErrorKind::Dns
            | ErrorKind::Refused
            | ErrorKind::Reset
            | ErrorKind::TimeoutIdle
            | ErrorKind::TimeoutConnect
            | ErrorKind::Other => Reason::Network,
            ErrorKind::Tls if matches!(error, ExecError::TlsHandshake { .. }) => Reason::Network,
            ErrorKind::PreRequestScript => Reason::Script,
            _ => Reason::Blocked,
        };
        self.outcome = Outcome::Failed;
        self.failure = Some(Failure { reason, message: secrets.mask(&error.to_string()) });
    }

    /// The run was stopped while it was being sent.
    pub(crate) fn cancelled(&mut self) {
        self.outcome = Outcome::Cancelled;
    }
}

/// `"name": message`, how a failed test reads in a failure message.
pub(crate) fn test_failure(test: &TestResult) -> String {
    match &test.message {
        Some(m) if m != &test.name => format!("\"{}\": {m}", test.name),
        _ => format!("\"{}\" failed", test.name),
    }
}

/// `path` from `root` with `/` between folders, or as it is when it's elsewhere.
fn file_label(root: Option<&Path>, path: &Path) -> String {
    match root.and_then(|r| path.strip_prefix(r).ok()) {
        Some(rel) => rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"),
        None => path.to_string_lossy().into_owned(),
    }
}

/// The Secret values a request was sent with, to mask wherever they show.
pub(crate) struct Secrets(Vec<String>);

impl Secrets {
    pub(crate) fn new(mut values: Vec<String>) -> Self {
        values.retain(|v| !v.is_empty());
        // A longer value first, so one containing another is masked whole.
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        Secrets(values)
    }

    /// `text` with each Secret value in it replaced by [`MASK`], also where it's
    /// percent-encoded, wholly or in part, as in a URL (`+` for a space, too).
    pub(crate) fn mask(&self, text: &str) -> String {
        let mut out = text.to_string();
        for value in &self.0 {
            out = mask_value(&out, value, false);
            if value.contains(' ') {
                out = mask_value(&out, value, true);
            }
        }
        out
    }
}

/// `text` with each occurrence of `value` replaced by [`MASK`], matching `text` with
/// its `%XX` escapes decoded (and `+` as a space when `plus_is_space`).
fn mask_value(text: &str, value: &str, plus_is_space: bool) -> String {
    let bytes = text.as_bytes();
    // Each decoded byte, with the span of `text` it came from.
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut spans = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: Option<&u8>| b.and_then(|b| (*b as char).to_digit(16));
        match (bytes[i], hex(bytes.get(i + 1)), hex(bytes.get(i + 2))) {
            (b'%', Some(hi), Some(lo)) => {
                decoded.push((hi * 16 + lo) as u8);
                spans.push((i, i + 3));
                i += 3;
            }
            (b'+', ..) if plus_is_space => {
                decoded.push(b' ');
                spans.push((i, i + 1));
                i += 1;
            }
            (b, ..) => {
                decoded.push(b);
                spans.push((i, i + 1));
                i += 1;
            }
        }
    }
    let needle = value.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at + needle.len() <= decoded.len() {
        if decoded[at..at + needle.len()] == *needle {
            let (start, end) = (spans[at].0, spans[at + needle.len() - 1].1);
            if text.is_char_boundary(start) && text.is_char_boundary(end) {
                out.push_str(&text[copied..start]);
                out.push_str(MASK);
                copied = end;
                at += needle.len();
                continue;
            }
        }
        at += 1;
    }
    out.push_str(&text[copied..]);
    out
}
