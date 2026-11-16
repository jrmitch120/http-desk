//! The Session: what HttpDesk remembers about a workspace from one send to the next.
//!
//! One Session per open workspace. It lives in memory only and is never written to
//! disk: opening a workspace starts a new one, and quitting forgets it. The shell
//! owns it and replaces it when the workspace changes; a send holds on to the
//! Session it started in, so one that finishes after a switch can't reach the next.
//!
//! Each part of the Session is its own section with its own lock, so a send reading
//! one never waits on another: prompt answers, the cookie jar, the latest exchange
//! of each named request, and Global variables.
//!
//! A new section is a private field with an accessor, and a line in [`Session::clear`]
//! (which won't compile until it has one), so Clear session empties it too.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use crate::cookies::CookieJar;
use crate::exchange::Exchanges;

/// What HttpDesk remembers about one workspace between sends (see the module docs).
/// Shared between sends behind an `Arc`; every section locks itself.
#[derive(Debug, Default)]
pub struct Session {
    prompt_answers: PromptAnswers,
    cookies: CookieJar,
    exchanges: Exchanges,
    globals: GlobalVariables,
}

impl Session {
    /// The values typed for Prompt variables, per request.
    pub fn prompt_answers(&self) -> &PromptAnswers {
        &self.prompt_answers
    }

    /// The cookies responses have set, sent on later requests they match. Every
    /// send in the Session uses it, whichever pooled client it goes out on.
    pub fn cookies(&self) -> &CookieJar {
        &self.cookies
    }

    /// The latest exchange of each named request, per file, which Request variables read.
    pub fn exchanges(&self) -> &Exchanges {
        &self.exchanges
    }

    /// The Global variables scripts have set with `client.global.set`, which every
    /// later request in the workspace can use as `{{name}}`.
    pub fn globals(&self) -> &GlobalVariables {
        &self.globals
    }

    /// Empties every section, as a new Session would be (Clear session). A send
    /// under way when it's cleared may still add to it as it finishes.
    pub fn clear(&self) {
        // Destructured, so a new section fails to compile until it's cleared here too.
        let Session { prompt_answers, cookies, exchanges, globals } = self;
        prompt_answers.clear();
        cookies.clear();
        exchanges.clear();
        globals.clear();
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

    /// Forgets every request's answers.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, String>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The Global variables of a Session: the values scripts store with
/// `client.global.set`, by name. A script reads and writes them as it runs, so a
/// handler that throws keeps what it set before the throw. Cloning shares them.
#[derive(Debug, Clone, Default)]
pub struct GlobalVariables(Arc<Mutex<BTreeMap<String, String>>>);

impl GlobalVariables {
    /// The value of `name`, if a script has set it.
    pub fn get(&self, name: &str) -> Option<String> {
        self.lock().get(name).cloned()
    }

    /// Sets `name` to `value`, replacing any value it had.
    pub fn set(&self, name: &str, value: &str) {
        self.lock().insert(name.to_string(), value.to_string());
    }

    /// Clears `name`; whether it was set.
    pub fn remove(&self, name: &str) -> bool {
        self.lock().remove(name).is_some()
    }

    /// Whether none is set.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Every one, sorted by name.
    pub fn list(&self) -> BTreeMap<String, String> {
        self.lock().clone()
    }

    /// Clears every one.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, String>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
