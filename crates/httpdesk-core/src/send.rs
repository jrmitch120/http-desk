//! One send, the way every send goes, whether the user sent the request or a Run did:
//! 1. resolve the Request variables the request writes, blocking on unsent or
//!    unmatched ones. Nothing has run yet: not even an untrusted workspace is reported;
//! 2. the pre-request script, which may set variables the request uses;
//! 3. resolve the rest and prepare (blocking on an Undefined variable in the host,
//!    and on Request variables inside other variables' values);
//! 4. execute with the Session's cookie jar;
//! 5. the response handler;
//! 6. record the named request's exchange in the Session.
//!
//! The shell's `send_request` and `run_requests` both send through [`send`], so a
//! step added here applies to both. The shell keeps only what is the UI's: the body
//! store, cancellation and events. Cancelling a send (dropping its future) also stops
//! a script it is running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::env::{self, EnvironmentSet};
use crate::exchange;
use crate::exec::{self, ClientPool, ExecError, ExecSettings, HttpResponse, SentRequest};
use crate::model::{HttpFile, Request, Variable};
use crate::script::{self, RequestScripts, ScriptContext};
use crate::session::Session;
use crate::vars::{MaskedValues, Resolver};

/// A request to send, with what its file gives it: the shape of the webview's
/// `RequestArgs` (without the environment, which is the whole send's).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    pub request: Request,
    /// The file it's in; `None` for a request in no file (it has no exchanges).
    #[serde(default)]
    pub file_path: Option<PathBuf>,
    /// The file's variables: its header's, then each request's.
    #[serde(default)]
    pub file_variables: Vec<Variable>,
    /// The file's `# @name`s, which its Request variables can read.
    #[serde(default)]
    pub request_names: Vec<String>,
    /// The webview's key for the request, which its Prompt variable answers are kept under.
    #[serde(default)]
    pub request_key: Option<String>,
}

impl Outgoing {
    /// Every request of `file` (read from `path`), in order, as it is in the file.
    /// No request key: their Prompt variables have no answers.
    pub fn all_in(path: &Path, file: &HttpFile) -> Vec<Outgoing> {
        let file_variables: Vec<Variable> =
            file.header.variables.iter().chain(file.requests.iter().flat_map(|r| &r.variables)).cloned().collect();
        let request_names = file.request_names();
        file.requests
            .iter()
            .map(|request| Outgoing {
                request: request.clone(),
                file_path: Some(path.to_path_buf()),
                file_variables: file_variables.clone(),
                request_names: request_names.clone(),
                request_key: None,
            })
            .collect()
    }
}

/// Whether a send runs the request's scripts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scripts {
    /// The workspace is trusted: they run.
    Run,
    /// The user chose to send without them: they don't, and the response says so.
    Skip,
    /// The workspace isn't trusted: a request with a script isn't sent.
    Untrusted,
}

/// What every send in a workspace shares: where and how it's sent, and the Session
/// it reads and updates. Cheap to clone.
#[derive(Clone)]
pub struct SendContext {
    /// The workspace root, whose environment files are read; `None` with no workspace.
    pub root: Option<PathBuf>,
    /// The selected environment.
    pub environment: Option<String>,
    pub settings: ExecSettings,
    pub scripts: Scripts,
    /// The Session the send started in, which it keeps even if another opens meanwhile.
    pub session: Arc<Session>,
    /// Idle clients, so a send can reuse a connection an earlier one left open.
    pub clients: ClientPool,
}

/// A send's response, with its complete body.
pub struct Sent {
    pub response: HttpResponse,
    pub body: Arc<[u8]>,
}

/// What a request is sent with (see [`scope`]).
pub struct RequestScope {
    pub resolver: Resolver,
    /// The folder its relative paths start from: its file's, else the root.
    pub base_dir: PathBuf,
    /// Set when its folder doesn't define the selected environment (it's then sent with none: ADR-0004).
    pub env_warning: Option<String>,
    /// The environment's variables, private ones included: what a pre-request
    /// script's `request.environment.get` reads.
    pub environment: HashMap<String, String>,
    /// The names in `environment` whose value is a Secret for this request.
    secrets: Vec<String>,
    /// The Session's answers to its Prompt variables.
    prompt_answers: Vec<String>,
}

/// What `out` is sent with: the variables (its folder's environment from disk, the
/// Session's Global variables, File variables and its own, and the Prompt variable
/// answers the Session holds for its request key; precedence is the Resolver's), and
/// the Request variables of its file's named requests (read
/// from their latest exchanges in the Session). Shared by send and preview so the two
/// can't disagree.
pub fn scope(
    root: Option<&Path>,
    environment: Option<&str>,
    session: &Session,
    out: &Outgoing,
) -> Result<RequestScope, ExecError> {
    let request = &out.request;
    let base_dir = base_dir(root, out);
    let env_set = match root {
        Some(r) => env::load_for(r, &base_dir).map_err(|e| ExecError::Other(e.to_string()))?,
        None => EnvironmentSet::default(),
    };
    let env_warning = match (root, environment) {
        (Some(r), Some(name)) if !env_set.environments.iter().any(|e| e.name == name) => Some(format!(
            "Environment \"{name}\" isn't defined for {}, so it's sent with no environment",
            folder_label(r, &base_dir)
        )),
        _ => None,
    };
    let env_vars = env::variables(&env_set, environment);
    let secrets = secret_names(&env_set, environment, out);
    let answers = out.request_key.as_deref().map(|k| session.prompt_answers().get(k)).unwrap_or_default();
    let prompts = request.prompts();
    let prompt_answers = prompts.iter().filter_map(|p| answers.get(&p.name).cloned()).collect();
    let resolver = Resolver::for_request(&env_vars, &out.file_variables, &request.variables, Some(&base_dir))
        .with_secrets(secrets.clone())
        .with_globals(session.globals().list())
        .with_prompts(&prompts, &answers)
        .with_request_variables(match &out.file_path {
            Some(file) => session.exchanges().for_file(file, &out.request_names),
            // Unsaved nowhere: its named requests have no exchanges.
            None => out.request_names.iter().map(|n| (n.clone(), None)).collect(),
        });
    Ok(RequestScope { resolver, base_dir, env_warning, environment: env_vars, secrets, prompt_answers })
}

/// The folder `out`'s relative paths start from: its file's, else the root.
fn base_dir(root: Option<&Path>, out: &Outgoing) -> PathBuf {
    out.file_path
        .as_deref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| root.map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The names whose value is a Secret for `out`: its environment's, except those a File
/// or request variable replaces (it's then no Secret). A Global variable or a
/// pre-request script's value replaces one only for some sends, so the Resolver
/// decides that per send.
fn secret_names(env_set: &EnvironmentSet, environment: Option<&str>, out: &Outgoing) -> Vec<String> {
    env::secret_names(env_set, environment)
        .into_iter()
        .filter(|n| !out.file_variables.iter().chain(&out.request.variables).any(|v| &v.name == n))
        .collect()
}

impl RequestScope {
    /// The values of the Secrets the request is sent with, for what must never show
    /// them (a Run's export). Empty ones are left out: there's nothing to hide.
    pub fn secret_values(&self) -> Vec<String> {
        self.secrets.iter().filter_map(|n| self.environment.get(n).filter(|v| !v.is_empty()).cloned()).collect()
    }

    /// The values History masks in the request's entry (ADR-0009): its Secrets' and
    /// its prompt answers.
    pub fn masked_values(&self) -> Vec<String> {
        self.secret_values().into_iter().chain(self.prompt_answers.iter().cloned()).collect()
    }
}

/// A folder as the UI names it: relative to the workspace root with a trailing `/`
/// (`api/users/`), or "the workspace root".
fn folder_label(root: &Path, dir: &Path) -> String {
    match env::relative_dir(root, dir) {
        rel if rel.is_empty() => "the workspace root".into(),
        rel => format!("{rel}/"),
    }
}

/// The warning on a response whose request has scripts that were skipped, naming them.
fn scripts_skipped(scripts: RequestScripts) -> String {
    let skipped = match (scripts.pre_request, scripts.handler) {
        (true, true) => "the pre-request script and the response handler",
        (true, false) => "the pre-request script",
        _ => "the response handler",
    };
    format!("Sent without scripts: {skipped} didn't run.")
}

/// Runs the request's pre-request script, if it has one, off the async workers
/// (it may take up to the script time limit).
async fn run_pre_request(
    request: &Request,
    environment: &HashMap<String, String>,
    scripts: &ScriptContext,
) -> Result<script::PreRequestResults, ExecError> {
    if request.pre_request_parts().is_empty() {
        return Ok(Default::default());
    }
    let (request, environment, scripts) = (request.clone(), environment.clone(), scripts.clone());
    tokio::task::spawn_blocking(move || script::run_pre_request_script(&request, &environment, &scripts))
        .await
        .map_err(|e| ExecError::Other(e.to_string()))?
}

/// Stops a send's scripts when the send ends, however it ends: dropped (cancelled)
/// included. A script runs on a blocking thread, which dropping its task doesn't stop.
struct StopOnDrop(script::Stop);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// The request a send put on the wire, once it got that far. A send that fails or
/// is cancelled after that still sent something (History records it, #151); one
/// that stopped before it (blocked) has none.
///
/// Made [`Attempt::for_history`] for a send History will record, it also keeps what
/// the entry needs and the request as sent doesn't hold: the start of the body sent,
/// up to History's body cap, and the values to mask, as the send resolved them. Any
/// other send (a Run's, a `# @no-log` one, one while History is off) copies nothing.
#[derive(Debug, Default)]
pub struct Attempt {
    request: Mutex<Option<SentRequest>>,
    history: Option<Mutex<ForHistory>>,
}

/// What a recorded send keeps for its History entry (see [`Attempt`]).
#[derive(Debug, Default)]
pub(crate) struct ForHistory {
    /// The start of the body it sent, up to [`crate::history::BODY_CAP`] bytes: more
    /// of it than the request as sent shows ([`SentRequest::body_preview`]).
    pub body: Option<Vec<u8>>,
    /// Its Secret values and prompt answers ([`RequestScope::masked_values`]).
    pub masked: MaskedValues,
}

impl Attempt {
    /// An attempt for a send History records (see [`Attempt`]).
    pub fn for_history() -> Attempt {
        Attempt { history: Some(Mutex::default()), ..Attempt::default() }
    }

    /// The request as it went out, before any redirect; `None` if nothing went out.
    pub fn request(&self) -> Option<SentRequest> {
        self.request.lock().unwrap().clone()
    }

    /// What it kept for History, taken out of it; `None` if it wasn't made for History.
    pub(crate) fn take_for_history(&self) -> Option<ForHistory> {
        self.history.as_ref().map(|h| std::mem::take(&mut *h.lock().unwrap()))
    }

    /// Notes the values to mask, from the scope the send resolved its variables in.
    fn resolved(&self, scope: &RequestScope) {
        if let Some(history) = &self.history {
            history.lock().unwrap().masked = MaskedValues::new(scope.masked_values());
        }
    }

    fn went_out(&self, p: &exec::PreparedRequest) {
        *self.request.lock().unwrap() = Some(SentRequest::of(p));
        if let Some(history) = &self.history {
            history.lock().unwrap().body = p.body.as_ref().map(|b| b[..b.len().min(crate::history::BODY_CAP)].to_vec());
        }
    }
}

/// Sends `out` in `ctx` (see the module docs). `on_progress` gets the body bytes
/// received so far (see [`exec::execute_on`]). Dropping the future cancels the send,
/// and stops a script it is running; a cancelled send records nothing in the Session.
pub async fn send(ctx: &SendContext, out: Outgoing, on_progress: impl FnMut(usize) + Send) -> Result<Sent, ExecError> {
    send_attempt(ctx, out, on_progress, &Attempt::default()).await
}

/// [`send`], noting in `attempt` the request it puts on the wire as it goes out, so
/// what was sent is known even when the send then fails or is cancelled.
pub async fn send_attempt(
    ctx: &SendContext,
    out: Outgoing,
    on_progress: impl FnMut(usize) + Send,
    attempt: &Attempt,
) -> Result<Sent, ExecError> {
    let scripts = RequestScripts::of(&out.request);
    let run_scripts = scripts.any() && ctx.scripts != Scripts::Skip;
    let stop = StopOnDrop(script::Stop::default());

    let (prepared, ssl, pre, script_context) = {
        let scope = scope(ctx.root.as_deref(), ctx.environment.as_deref(), &ctx.session, &out)?;
        attempt.resolved(&scope);
        // Blocked before anything runs: no script can define a Request variable, so
        // none can unblock it, and asking to trust the workspace wouldn't either.
        exec::check_request_variables(&out.request, &scope.resolver)?;
        if run_scripts && ctx.scripts == Scripts::Untrusted {
            return Err(ExecError::UntrustedWorkspace);
        }
        let script_context = ScriptContext {
            // Script files are read relative to the `.http` file, from inside the workspace.
            files: script::ScriptFiles::new(ctx.root.as_deref(), &scope.base_dir),
            globals: ctx.session.globals().clone(),
            stop: stop.0.clone(),
        };
        // JetBrains order: the pre-request script runs before variables are substituted.
        let pre = if run_scripts {
            run_pre_request(&out.request, &scope.environment, &script_context).await?
        } else {
            Default::default()
        };
        // The Global variables again: the script may have set some.
        let resolver =
            scope.resolver.with_pre_request_variables(&pre.variables).with_globals(ctx.session.globals().list());
        let mut prepared = exec::prepare(&out.request, &resolver, &scope.base_dir, &ctx.settings)?;
        prepared.warnings.splice(0..0, scope.env_warning);
        if scripts.any() && !run_scripts {
            prepared.warnings.push(scripts_skipped(scripts));
        }
        let ssl = match (&ctx.root, &ctx.environment) {
            (Some(r), Some(e)) => env::ssl_config(r, &scope.base_dir, e),
            _ => Default::default(),
        };
        (prepared, ssl, pre.results, script_context)
    };

    // A `# @name` request's exchange becomes its latest, in the Session the send started in.
    let pending = exchange::begin(out.file_path.as_deref(), &out.request, &prepared);
    // Each send gets a client no other send is using (see ClientPool).
    let client = ctx.clients.checkout(&prepared, &ctx.settings, &ssl)?;
    attempt.went_out(&prepared);
    let mut outcome =
        exec::execute_on(&client, prepared, &ctx.settings, Some(ctx.session.cookies()), on_progress).await?;
    drop(client);
    let body: Arc<[u8]> = std::mem::take(&mut outcome.body).into();
    let mut response = outcome.response;
    if run_scripts {
        // Up to the script time limit of CPU work: off the async workers.
        let request = out.request.clone();
        let handler_body = body.clone();
        response = tokio::task::spawn_blocking(move || {
            let results = script::run_response_handler(&request, &response, &handler_body, &script_context);
            // The pre-request script's tests and logs come first.
            response.tests = pre.tests.into_iter().chain(results.tests).collect();
            response.logs = pre.logs.into_iter().chain(results.logs).collect();
            response
        })
        .await
        .map_err(|e| ExecError::Other(e.to_string()))?;
    }
    if let Some(pending) = pending {
        pending.finish(ctx.session.exchanges(), &response, body.clone());
    }
    Ok(Sent { response, body })
}
