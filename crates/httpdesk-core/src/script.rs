//! JetBrains scripts, run in a sandboxed embedded QuickJS (ADR-0008).
//!
//! Each script gets a fresh runtime and context (`Sandbox`) with fixed limits
//! ([`TIME_LIMIT`], [`MEMORY_LIMIT`], [`LOG_LIMIT`]) and no filesystem, network or process
//! APIs: QuickJS has none until they're added, and only the API in
//! `script/prelude.js` is. The prelude builds the JetBrains `client`/`response`/
//! `request` objects from two things `install` hands it: `data`, the exchange
//! as JSON, and `host`, the Rust functions it calls (`host.test`, `host.log`,
//! `host.setVariable`). A response handler's `data` is the response; a
//! pre-request script's is the environment and the variables set so far.
//!
//! To implement a JetBrains API (`client.global.*`): add a Rust function to
//! `host` in `install` (state it needs goes on `Recorded` or alongside it,
//! like `SetVariables`), call it from the prelude, take the name out of the
//! prelude's unsupported namespace it falls under, and list it in
//! `script/api.json`, which the Scripts editor's completion offers (a test
//! checks the list against the prelude).
//!
//! A script written as a file reference (`< sign.js`, `> check.js`) is read by
//! [`ScriptFiles`], relative to the `.http` file and only from inside the
//! workspace, then runs like an inline one. Scripts themselves still read no files.
//!
//! A response handler never fails the send: its errors, including running out of
//! time or memory, become failed [`TestResult`]s. A pre-request script's error
//! does: it is [`ExecError::PreRequestScript`], and nothing is sent.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::{CatchResultExt, CaughtError, Context, Ctx, Function, Object, Runtime, Value};
use serde::{Deserialize, Serialize};

use crate::exec::{decode_text, ExecError, HttpResponse};
use crate::model::{HandlerPart, PreRequestPart, Request};

/// How long a script may run. Fixed: there is no setting.
pub const TIME_LIMIT: Duration = Duration::from_secs(5);
/// How much memory a script's runtime may hold, the response body included. Fixed: there is no setting.
pub const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
/// How much `client.log` text a script may keep. Fixed: there is no setting.
pub const LOG_LIMIT: usize = 1024 * 1024;

const PRELUDE: &str = include_str!("script/prelude.js");
/// The file name scripts are evaluated as, which error stacks quote.
const SCRIPT_FILE: &str = "<script>";
/// The test name a response handler's own error is reported under.
pub const HANDLER_TEST_NAME: &str = "Response handler";

/// One `client.test`, top-level `client.assert`, or script error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    /// Why it failed; `None` when it passed.
    pub message: Option<String>,
}

/// What running a request's scripts produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptResults {
    pub tests: Vec<TestResult>,
    pub logs: Vec<String>,
}

/// Whether sending `request` would run any script, which only a Trusted
/// workspace may do.
pub fn has_scripts(request: &Request) -> bool {
    !request.pre_request_parts().is_empty() || request.response_handler_parts().iter().any(HandlerPart::is_script)
}

/// What a request's pre-request script produced: the values it set with
/// `request.variables.set` (for `{{name}}` in this request only, see
/// [`crate::vars::Resolver::with_pre_request_variables`]) and its tests and logs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreRequestResults {
    pub variables: HashMap<String, String>,
    pub results: ScriptResults,
}

/// Runs `request`'s pre-request script, before its variables are substituted.
/// `environment` is what `request.environment.get` reads: the selected
/// environment's variables, private ones included. A script that throws, runs
/// out of time or memory, or can't run is an error, and the request mustn't be
/// sent.
pub fn run_pre_request_script(
    request: &Request,
    environment: &HashMap<String, String>,
    files: &ScriptFiles,
) -> Result<PreRequestResults, ExecError> {
    let mut out = PreRequestResults::default();
    for part in request.pre_request_parts() {
        let script = match part {
            PreRequestPart::Inline { source, line } => Script { source, origin: Origin::Inline(line) },
            PreRequestPart::File { path } => match files.read(&path) {
                Ok(source) => Script { source, origin: Origin::File(path) },
                Err(message) => return Err(ExecError::PreRequestScript { message, line: None }),
            },
        };
        let data = serde_json::json!({
            "request": { "environment": environment, "variables": out.variables },
        });
        let mut run = Sandbox::run(&script.source, &data);
        out.results.tests.append(&mut run.results.tests);
        out.results.logs.append(&mut run.results.logs);
        out.variables.extend(run.variables);
        if let Some(e) = run.error {
            // The UI names a line of the request's own script; a file's is in the message.
            return Err(match script.origin {
                Origin::Inline(line) => {
                    ExecError::PreRequestScript { message: e.message, line: e.line.map(|l| line + l - 1) }
                }
                Origin::File(_) => ExecError::PreRequestScript { message: script.origin.describe(e), line: None },
            });
        }
    }
    Ok(out)
}

/// Runs `request`'s response handler against the response it got. `>>` output
/// redirects are not run.
pub fn run_response_handler(
    request: &Request,
    response: &HttpResponse,
    body: &[u8],
    files: &ScriptFiles,
) -> ScriptResults {
    let parts = request.response_handler_parts();
    let mut results = ScriptResults::default();
    if !parts.iter().any(HandlerPart::is_script) {
        return results;
    }
    let data = serde_json::json!({ "response": response_data(response, body) });
    let failed = |message| TestResult { name: HANDLER_TEST_NAME.into(), passed: false, message: Some(message) };
    for part in parts {
        let script = match part {
            HandlerPart::Inline { source, line } => Script { source, origin: Origin::Inline(line) },
            HandlerPart::File { path } => match files.read(&path) {
                Ok(source) => Script { source, origin: Origin::File(path) },
                Err(message) => {
                    results.tests.push(failed(message));
                    continue;
                }
            },
            HandlerPart::Redirect { .. } => continue,
        };
        let mut run = Sandbox::run(&script.source, &data);
        if let Some(e) = run.error {
            run.results.tests.push(failed(script.origin.describe(e)));
        }
        results.tests.append(&mut run.results.tests);
        results.logs.append(&mut run.results.logs);
    }
    results
}

/// Where a request's script files (`< sign.js`, `> check.js`) are read from:
/// relative to its `.http` file's folder, and only from inside the workspace.
/// Symlinks are followed before that check, so a link can't reach outside.
#[derive(Debug, Clone, Default)]
pub struct ScriptFiles {
    /// The workspace root; `None` when no workspace is open, and nothing can be read.
    root: Option<PathBuf>,
    /// The `.http` file's folder.
    dir: PathBuf,
}

impl ScriptFiles {
    /// Files of a `.http` file in `dir`, in the workspace at `root`.
    pub fn new(root: Option<&Path>, dir: &Path) -> Self {
        ScriptFiles { root: root.map(Path::to_path_buf), dir: dir.to_path_buf() }
    }

    /// The file `reference` (as written after `<` or `>`) names, with symlinks
    /// resolved, or why it can't be used: it doesn't exist, isn't a file, or is
    /// (or points) outside the workspace.
    pub fn locate(&self, reference: &str) -> Result<PathBuf, String> {
        let failed = |why: &str| format!("Script file {reference} {why}");
        let Some(root) = &self.root else { return Err(failed("can't be read: no workspace is open")) };
        let root = std::fs::canonicalize(root).map_err(|e| failed(&format!("can't be read: {e}")))?;
        let path = self.dir.join(reference);
        let target = match std::fs::canonicalize(&path) {
            Ok(target) => target,
            // A file outside is refused for that, whether or not it exists.
            Err(_) if !resolve_existing(&path).starts_with(&root) => return Err(failed("is outside the workspace")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(failed("doesn't exist")),
            Err(e) => return Err(failed(&format!("can't be read: {e}"))),
        };
        if !target.starts_with(&root) {
            return Err(failed("is outside the workspace"));
        }
        if !target.is_file() {
            return Err(failed("isn't a file"));
        }
        Ok(target)
    }

    /// The text of the file `reference` names (see [`ScriptFiles::locate`]).
    pub fn read(&self, reference: &str) -> Result<String, String> {
        let path = self.locate(reference)?;
        std::fs::read_to_string(path).map_err(|e| format!("Script file {reference} can't be read: {e}"))
    }
}

/// `path` with its longest existing ancestor canonicalized and the rest applied
/// lexically, to tell where a path that doesn't exist would be.
fn resolve_existing(path: &Path) -> PathBuf {
    let comps: Vec<Component> = path.components().collect();
    for i in (1..=comps.len()).rev() {
        let Ok(mut out) = std::fs::canonicalize(comps[..i].iter().collect::<PathBuf>()) else { continue };
        for c in &comps[i..] {
            match c {
                Component::Normal(n) => out.push(n),
                Component::ParentDir => {
                    out.pop();
                }
                _ => {}
            }
        }
        return out;
    }
    path.to_path_buf()
}

/// A script to run, and where its text came from.
struct Script {
    source: String,
    origin: Origin,
}

/// Where a script's text is: in the `.http` file, from this line (1-based) of the
/// pre-request script or handler on, or in a script file, as referenced.
enum Origin {
    Inline(usize),
    File(String),
}

impl Origin {
    /// The script's error message, naming the line it was at.
    fn describe(&self, e: ScriptError) -> String {
        let at = match (self, e.line) {
            (_, None) => String::new(),
            (Origin::Inline(line), Some(l)) => format!(" (line {})", line + l - 1),
            (Origin::File(path), Some(l)) => format!(" ({path} line {l})"),
        };
        format!("{}{at}", e.message)
    }
}

/// The response as the prelude reads it.
fn response_data(response: &HttpResponse, body: &[u8]) -> serde_json::Value {
    let ct = response.content_type.as_deref();
    let text = decode_text(body, ct).unwrap_or_else(|| String::from_utf8_lossy(body).into_owned());
    let mut params = ct.unwrap_or("").split(';').map(str::trim);
    let mime_type = params.next().unwrap_or("").to_string();
    let charset = params.find_map(|p| p.strip_prefix("charset=")).map(|c| c.trim_matches('"').to_string());
    serde_json::json!({
        "status": response.status,
        "headers": response.headers,
        "body": text,
        "json": response.body_kind == crate::body_format::ResponseKind::Json,
        "mimeType": mime_type,
        "charset": charset,
    })
}

/// A script's own failure: its message and the script line (1-based) it was at.
struct ScriptError {
    message: String,
    line: Option<usize>,
}

struct Run {
    results: ScriptResults,
    /// What `request.variables.set` set, in a pre-request script.
    variables: HashMap<String, String>,
    error: Option<ScriptError>,
}

/// What a script's `host` functions record, read once it has finished.
type Recorded = Rc<RefCell<ScriptResults>>;
/// What a pre-request script's `request.variables.set` calls set.
type SetVariables = Rc<RefCell<HashMap<String, String>>>;

/// One script in a fresh QuickJS runtime and context.
struct Sandbox;

impl Sandbox {
    fn run(source: &str, data: &serde_json::Value) -> Run {
        let recorded = Recorded::default();
        let variables = SetVariables::default();
        let error = Self::try_run(source, data, &recorded, &variables).err();
        let results = recorded.take();
        Run { results, variables: variables.take(), error }
    }

    fn try_run(
        source: &str,
        data: &serde_json::Value,
        recorded: &Recorded,
        variables: &SetVariables,
    ) -> Result<(), ScriptError> {
        let engine = |e: rquickjs::Error| ScriptError { message: format!("Script engine error: {e}"), line: None };
        let rt = Runtime::new().map_err(engine)?;
        rt.set_memory_limit(MEMORY_LIMIT);
        rt.set_max_stack_size(1024 * 1024);
        let started = Instant::now();
        let timed_out = Rc::new(Cell::new(false));
        let flag = timed_out.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let over = started.elapsed() > TIME_LIMIT;
            if over {
                flag.set(true);
            }
            over
        })));
        let ctx = Context::full(&rt).map_err(engine)?;
        let outcome = ctx.with(|ctx| {
            let result = install(&ctx, data, recorded, variables).and_then(|()| {
                ctx.eval_with_options::<(), _>(source, options(SCRIPT_FILE))?;
                while ctx.execute_pending_job() {}
                Ok(())
            });
            result.catch(&ctx).map_err(|caught| describe(caught, timed_out.get()))
        });
        match outcome {
            // QuickJS throws `null` when it can't even allocate the out-of-memory error.
            Err(Failure::Null) if rt.memory_usage().malloc_size as usize > MEMORY_LIMIT / 4 * 3 => Err(memory_error()),
            Err(Failure::Null) => Err(ScriptError { message: "null".into(), line: None }),
            Err(Failure::Error(e)) => Err(e),
            Ok(()) => Ok(()),
        }
    }
}

/// How a script failed, before telling a thrown `null` from running out of memory.
enum Failure {
    Error(ScriptError),
    Null,
}

/// Evaluates the prelude and calls it with `host` and the exchange's data.
fn install<'js>(
    ctx: &Ctx<'js>,
    data: &serde_json::Value,
    recorded: &Recorded,
    variables: &SetVariables,
) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    let tests = recorded.clone();
    host.set(
        "test",
        Function::new(ctx.clone(), move |name: String, passed: bool, message: Option<String>| {
            tests.borrow_mut().tests.push(TestResult { name, passed, message });
        })?,
    )?;
    let set = variables.clone();
    host.set(
        "setVariable",
        Function::new(ctx.clone(), move |name: String, value: String| {
            set.borrow_mut().insert(name, value);
        })?,
    )?;
    let logs = recorded.clone();
    let logged = Cell::new(0);
    host.set("log", Function::new(ctx.clone(), move |line: String| log(&mut logs.borrow_mut().logs, &logged, line))?)?;
    let mut data = data.clone();
    data["limits"] = serde_json::json!({ "time": human(TIME_LIMIT), "memory": format!("{} MB", MEMORY_LIMIT >> 20) });
    let data: Value = ctx.json_parse(data.to_string())?;
    let prelude: Function = ctx.eval_with_options(PRELUDE, options("<prelude>"))?;
    prelude.call::<_, ()>((host, data))
}

/// Keeps a `client.log` line, unless the script has already logged [`LOG_LIMIT`]
/// bytes (`logged`, each line counting one more for its line break): then one
/// line says the log stopped and the rest are dropped. The log is held outside
/// the script's runtime, so its memory limit doesn't cover it.
fn log(logs: &mut Vec<String>, logged: &Cell<usize>, line: String) {
    let before = logged.get();
    logged.set(before.saturating_add(line.len() + 1));
    if logged.get() <= LOG_LIMIT {
        logs.push(line);
    } else if before <= LOG_LIMIT {
        logs.push(format!("Log stopped at {} MB, the log limit for a script", LOG_LIMIT >> 20));
    }
}

fn options(file: &str) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.filename = Some(file.into());
    options.global = true;
    options.strict = false;
    options
}

fn human(d: Duration) -> String {
    format!("{} s", d.as_secs())
}

/// The message and line a failed script reports.
fn describe(caught: CaughtError<'_>, timed_out: bool) -> Failure {
    if timed_out {
        return Failure::Error(ScriptError {
            message: format!("Stopped after {}, the time limit for a script", human(TIME_LIMIT)),
            line: None,
        });
    }
    let (message, stack) = match caught {
        CaughtError::Exception(e) => {
            let name: Option<String> = e.as_object().get("name").ok();
            let message = e.message().unwrap_or_default();
            let message = match name.as_deref() {
                Some("InternalError") if message == "out of memory" => return Failure::Error(memory_error()),
                Some("Error" | "UnsupportedApiError") | None => message,
                Some(name) => format!("{name}: {message}"),
            };
            (message, e.stack())
        }
        CaughtError::Value(v) if v.is_null() => return Failure::Null,
        CaughtError::Value(v) => (value_text(&v), None),
        CaughtError::Error(e) => (e.to_string(), None),
    };
    Failure::Error(ScriptError { message, line: stack.as_deref().and_then(script_line) })
}

fn memory_error() -> ScriptError {
    ScriptError { message: format!("Stopped at {} MB, the memory limit for a script", MEMORY_LIMIT >> 20), line: None }
}

fn value_text(v: &Value<'_>) -> String {
    if let Some(s) = v.as_string() {
        return s.to_string().unwrap_or_default();
    }
    v.ctx()
        .json_stringify(v.clone())
        .ok()
        .flatten()
        .and_then(|s| s.to_string().ok())
        .unwrap_or_else(|| "Script threw".into())
}

/// The first line of the user's script in a QuickJS stack (`at f (<script>:3:5)`).
fn script_line(stack: &str) -> Option<usize> {
    let at = stack.find(&format!("{SCRIPT_FILE}:"))? + SCRIPT_FILE.len() + 1;
    let digits: String = stack[at..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}
