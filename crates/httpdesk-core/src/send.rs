//! One send, the way every send goes, whether the user sent the request or a Run did:
//! resolve (blocking on unsent or unmatched Request variables) → prepare → execute with
//! the Session's cookie jar → response handler → record the named request's exchange
//! in the Session. A pre-request script goes between resolving and preparing.
//!
//! The shell's `send_request` and `run_requests` both send through [`send`], so a
//! step added here applies to both. The shell keeps only what is the UI's: the body
//! store, cancellation and events.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;

use crate::env::{self, EnvironmentSet};
use crate::exchange;
use crate::exec::{self, ClientPool, ExecError, ExecSettings, HttpResponse};
use crate::model::{HttpFile, Request, Variable};
use crate::script;
use crate::session::Session;
use crate::vars::Resolver;

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
}

/// What `out` is sent with: the variables (its folder's environment from disk, then
/// File variables, then its own, then the Prompt variable answers the Session holds
/// for its request key), and the Request variables of its file's named requests (read
/// from their latest exchanges in the Session). Shared by send and preview so the two
/// can't disagree.
pub fn scope(
    root: Option<&Path>,
    environment: Option<&str>,
    session: &Session,
    out: &Outgoing,
) -> Result<RequestScope, ExecError> {
    let request = &out.request;
    let base_dir = out
        .file_path
        .as_deref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| root.map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
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
    // A File variable of a Secret's name replaces it, so it's no Secret.
    let secrets = env::secret_names(&env_set, environment)
        .into_iter()
        .filter(|n| !out.file_variables.iter().chain(&request.variables).any(|v| &v.name == n));
    let answers = out.request_key.as_deref().map(|k| session.prompt_answers().get(k)).unwrap_or_default();
    let resolver = Resolver::for_request(&env_vars, &out.file_variables, &request.variables, Some(&base_dir))
        .with_secrets(secrets)
        .with_prompts(&request.prompts(), &answers)
        .with_request_variables(match &out.file_path {
            Some(file) => session.exchanges().for_file(file, &out.request_names),
            // Unsaved nowhere: its named requests have no exchanges.
            None => out.request_names.iter().map(|n| (n.clone(), None)).collect(),
        });
    Ok(RequestScope { resolver, base_dir, env_warning })
}

/// A folder as the UI names it: relative to the workspace root with a trailing `/`
/// (`api/users/`), or "the workspace root".
fn folder_label(root: &Path, dir: &Path) -> String {
    match env::relative_dir(root, dir) {
        rel if rel.is_empty() => "the workspace root".into(),
        rel => format!("{rel}/"),
    }
}

/// The warning on a response whose request has a script that was skipped.
pub const SCRIPTS_SKIPPED: &str = "Sent without scripts: the response handler didn't run.";

/// Sends `out` in `ctx` (see the module docs). `on_progress` gets the body bytes
/// received so far (see [`exec::execute_on`]). Dropping the future cancels the send;
/// a cancelled send records nothing in the Session.
pub async fn send(ctx: &SendContext, out: Outgoing, on_progress: impl FnMut(usize) + Send) -> Result<Sent, ExecError> {
    let has_scripts = script::has_scripts(&out.request);
    let run_scripts = has_scripts && ctx.scripts != Scripts::Skip;
    if run_scripts && ctx.scripts == Scripts::Untrusted {
        return Err(ExecError::UntrustedWorkspace);
    }

    let (prepared, ssl) = {
        let scope = scope(ctx.root.as_deref(), ctx.environment.as_deref(), &ctx.session, &out)?;
        let mut prepared = exec::prepare(&out.request, &scope.resolver, &scope.base_dir, &ctx.settings)?;
        prepared.warnings.splice(0..0, scope.env_warning);
        if has_scripts && !run_scripts {
            prepared.warnings.push(SCRIPTS_SKIPPED.into());
        }
        let ssl = match (&ctx.root, &ctx.environment) {
            (Some(r), Some(e)) => env::ssl_config(r, &scope.base_dir, e),
            _ => Default::default(),
        };
        (prepared, ssl)
    };

    // A `# @name` request's exchange becomes its latest, in the Session the send started in.
    let pending = exchange::begin(out.file_path.as_deref(), &out.request, &prepared);
    // Each send gets a client no other send is using (see ClientPool).
    let client = ctx.clients.checkout(&prepared, &ctx.settings, &ssl)?;
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
            let results = script::run_response_handler(&request, &response, &handler_body);
            response.tests = results.tests;
            response.logs = results.logs;
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
