//! The Session: what HttpDesk remembers about a workspace from one send to the next.
//!
//! One Session per open workspace. It lives in memory only and is never written to
//! disk: opening a workspace starts a new one, and quitting forgets it. The shell
//! owns it and replaces it when the workspace changes; a send holds on to the
//! Session it started in, so one that finishes after a switch can't reach the next.
//!
//! Each part of the Session is its own section with its own lock, so a send reading
//! one never waits on another. Today that is prompt answers. The cookie jar, the
//! latest exchange of each named request and Global variables join them as further
//! sections.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// What HttpDesk remembers about one workspace between sends (see the module docs).
/// Shared between sends behind an `Arc`; every section locks itself.
#[derive(Debug, Default)]
pub struct Session {
    prompt_answers: PromptAnswers,
}

impl Session {
    /// The values typed for Prompt variables, per request.
    pub fn prompt_answers(&self) -> &PromptAnswers {
        &self.prompt_answers
    }
}

/// The values typed for Prompt variables, per request, by prompt name. A request's
/// answers are reused on its next send until they are forgotten or the Session ends.
///
/// Requests are identified by a key the caller chooses: the webview's key for the
/// request, which follows it through edits and moves within its file. Core never
/// interprets it.
#[derive(Debug, Default)]
pub struct PromptAnswers(Mutex<HashMap<String, HashMap<String, String>>>);

impl PromptAnswers {
    /// The answers remembered for `request` (empty when it has none).
    pub fn get(&self, request: &str) -> HashMap<String, String> {
        self.lock().get(request).cloned().unwrap_or_default()
    }

    /// Remembers `answers` for `request`, keeping its earlier answers to other
    /// prompts. An answer to a prompt already answered replaces it.
    pub fn answer(&self, request: &str, answers: HashMap<String, String>) {
        self.lock().entry(request.to_string()).or_default().extend(answers);
    }

    /// Forgets every answer for `request`, so its next send asks again.
    pub fn forget(&self, request: &str) {
        self.lock().remove(request);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, String>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
