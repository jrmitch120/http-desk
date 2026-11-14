//! JetBrains scripts, run in a sandboxed embedded QuickJS (ADR-0008).
//!
//! Each script gets a fresh runtime and context (`Sandbox`) with fixed limits
//! ([`TIME_LIMIT`], [`MEMORY_LIMIT`], [`LOG_LIMIT`]) and no filesystem, network or process
//! APIs: QuickJS has none until they're added, and only the API in
//! `script/prelude.js` is. The prelude builds the JetBrains `client`/`response`/
//! `request` objects from two things `install` hands it: `data`, the exchange
//! as JSON, and `host`, the Rust functions it calls (`host.test`, `host.log`,
//! `host.testFailed`, `host.setVariable`, `host.global*`). A response handler's `data` is the
//! response; a pre-request script's is the environment and the variables set so far.
//! Both read and write the Session's Global variables ([`GlobalVariables`]) as
//! they run, so a value set before a script throws or is stopped stays set.
//!
//! To implement a JetBrains API: add a Rust function to
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
//!
//! The runtime's allocator ([`LimitedAllocator`]) enforces [`MEMORY_LIMIT`] and
//! records when it refuses an allocation: that, not what the script throws (QuickJS
//! throws `null` when it can't even allocate its out-of-memory error), is how
//! running out of memory is told apart.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::allocator::{Allocator, RustAllocator};
use rquickjs::context::EvalOptions;
use rquickjs::{CatchResultExt, CaughtError, Coerced, Context, Ctx, FromJs, Function, Object, Runtime, Value};
use serde::{Deserialize, Serialize};

use crate::exec::{text_lossy, ExecError, HttpResponse};
use crate::model::{HandlerPart, Request, ScriptSource};
use crate::session::GlobalVariables;

/// How long a script may run. Fixed: there is no setting.
pub const TIME_LIMIT: Duration = Duration::from_secs(5);
/// How much memory a script's runtime may hold, the response body included. Fixed: there is no setting.
pub const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
/// How much `client.log` text a script may keep. Fixed: there is no setting. The
/// log goes to the webview in the send's reply (and in each `run-progress` event of
/// a Run), and the Tests tab shows every line, so this is enough to debug with
/// (about a thousand lines), not enough to slow either down.
pub const LOG_LIMIT: usize = 64 * 1024;

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

/// Which scripts sending a request would run, which only a Trusted workspace may do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestScripts {
    pub pre_request: bool,
    /// A response handler that runs (a `>>` redirect alone doesn't).
    pub handler: bool,
}

impl RequestScripts {
    pub fn of(request: &Request) -> Self {
        RequestScripts {
            pre_request: !request.pre_request_parts().is_empty(),
            handler: request.response_handler_parts().iter().any(HandlerPart::is_script),
        }
    }

    pub fn any(self) -> bool {
        self.pre_request || self.handler
    }
}

/// Whether sending `request` would run any script (see [`RequestScripts`]).
pub fn has_scripts(request: &Request) -> bool {
    RequestScripts::of(request).any()
}

/// What a request's pre-request script produced: the values it set with
/// `request.variables.set` (for `{{name}}` in this request only, see
/// [`crate::vars::Resolver::with_pre_request_variables`]) and its tests and logs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreRequestResults {
    pub variables: HashMap<String, String>,
    pub results: ScriptResults,
}

/// What a request's scripts run with: where its script files are read from, the
/// Session's Global variables `client.global` reads and writes, and what stops them.
#[derive(Debug, Clone, Default)]
pub struct ScriptContext {
    pub files: ScriptFiles,
    pub globals: GlobalVariables,
    pub stop: Stop,
}

/// Stops a send's scripts when the send is cancelled, wherever they've got to: the
/// engine checks it as a script runs, as it checks the time limit. What a script
/// set before it stopped (Global variables) stands. Clones share it.
#[derive(Debug, Clone, Default)]
pub struct Stop(Arc<AtomicBool>);

impl Stop {
    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Runs `request`'s pre-request script, before its variables are substituted.
/// `environment` is what `request.environment.get` reads: the selected
/// environment's variables, private ones included. A script that throws, runs out
/// of time or memory, is stopped, or can't run is an error, and the request mustn't
/// be sent.
pub fn run_pre_request_script(
    request: &Request,
    environment: &HashMap<String, String>,
    ctx: &ScriptContext,
) -> Result<PreRequestResults, ExecError> {
    let mut out = PreRequestResults::default();
    for part in request.pre_request_parts() {
        let script =
            Script::load(part, &ctx.files).map_err(|message| ExecError::PreRequestScript { message, line: None })?;
        let data = serde_json::json!({
            "request": { "environment": environment, "variables": out.variables },
        });
        let mut run = Sandbox::run(&script.source, &data, ctx);
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
    ctx: &ScriptContext,
) -> ScriptResults {
    let parts = request.response_handler_parts();
    let mut results = ScriptResults::default();
    if !parts.iter().any(HandlerPart::is_script) {
        return results;
    }
    let data = serde_json::json!({ "response": response_data(response, body) });
    let failed = |message| TestResult { name: HANDLER_TEST_NAME.into(), passed: false, message: Some(message) };
    for part in parts {
        let HandlerPart::Script(source) = part else { continue };
        let script = match Script::load(source, &ctx.files) {
            Ok(script) => script,
            Err(message) => {
                results.tests.push(failed(message));
                continue;
            }
        };
        let mut run = Sandbox::run(&script.source, &data, ctx);
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

impl Script {
    /// The script `source` names: its text as written, or its file's (read with
    /// `files`), or why that file can't be read.
    fn load(source: ScriptSource, files: &ScriptFiles) -> Result<Script, String> {
        Ok(match source {
            ScriptSource::Inline { source, line } => Script { source, origin: Origin::Inline(line) },
            ScriptSource::File { path } => Script { source: files.read(&path)?, origin: Origin::File(path) },
        })
    }
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
    let mut params = ct.unwrap_or("").split(';').map(str::trim);
    let mime_type = params.next().unwrap_or("").to_string();
    let charset = params.find_map(|p| p.strip_prefix("charset=")).map(|c| c.trim_matches('"').to_string());
    serde_json::json!({
        "status": response.status,
        "headers": response.headers,
        "body": text_lossy(body, ct),
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
/// Set when the runtime's allocator refused an allocation (see [`LimitedAllocator`]),
/// until a failure is reported as running out of memory.
type Exhausted = Rc<Cell<bool>>;

/// Why the engine interrupted a script.
#[derive(Debug, Clone, Copy)]
enum Interrupted {
    TimedOut,
    Stopped,
}

/// One script in a fresh QuickJS runtime and context.
struct Sandbox;

impl Sandbox {
    fn run(source: &str, data: &serde_json::Value, ctx: &ScriptContext) -> Run {
        let recorded = Recorded::default();
        let variables = SetVariables::default();
        let error = Self::try_run(source, data, &recorded, &variables, ctx).err();
        let results = recorded.take();
        Run { results, variables: variables.take(), error }
    }

    fn try_run(
        source: &str,
        data: &serde_json::Value,
        recorded: &Recorded,
        variables: &SetVariables,
        ctx: &ScriptContext,
    ) -> Result<(), ScriptError> {
        let engine = |e: rquickjs::Error| ScriptError { message: format!("Script engine error: {e}"), line: None };
        let exhausted = Exhausted::default();
        let rt = Runtime::new_with_alloc(LimitedAllocator { used: 0, exhausted: exhausted.clone() }).map_err(engine)?;
        rt.set_max_stack_size(1024 * 1024);
        let started = Instant::now();
        let interrupted = Rc::new(Cell::new(None));
        let (why, stop) = (interrupted.clone(), ctx.stop.clone());
        rt.set_interrupt_handler(Some(Box::new(move || {
            let reason = match () {
                _ if stop.is_stopped() => Some(Interrupted::Stopped),
                _ if started.elapsed() > TIME_LIMIT => Some(Interrupted::TimedOut),
                _ => None,
            };
            why.set(reason.or(why.get()));
            reason.is_some()
        })));
        let context = Context::full(&rt).map_err(engine)?;
        let host = Host { recorded, variables, globals: &ctx.globals, exhausted: &exhausted };
        context.with(|js| {
            let result = install(&js, data, &host).and_then(|()| {
                js.eval_with_options::<(), _>(source, options(SCRIPT_FILE))?;
                while js.execute_pending_job() {}
                Ok(())
            });
            result.catch(&js).map_err(|caught| match interrupted.get() {
                Some(Interrupted::TimedOut) => ScriptError {
                    message: format!("Stopped after {}, the time limit for a script", human(TIME_LIMIT)),
                    line: None,
                },
                Some(Interrupted::Stopped) => {
                    ScriptError { message: "Stopped: the send was cancelled".into(), line: None }
                }
                None if exhausted.take() => ScriptError { message: memory_message(), line: None },
                None => describe(caught),
            })
        })
    }
}

/// The runtime's memory, from Rust's allocator, with [`MEMORY_LIMIT`] enforced here
/// rather than by QuickJS: an allocation that would go past it is refused, and the
/// refusal recorded in `exhausted`.
struct LimitedAllocator {
    /// Bytes held, as `RustAllocator::usable_size` counts them.
    used: usize,
    exhausted: Exhausted,
}

impl LimitedAllocator {
    /// Whether `size` more bytes fit once `freed` are given back; records a refusal.
    fn fits(&self, freed: usize, size: usize) -> bool {
        let fits = (self.used - freed).checked_add(size).is_some_and(|total| total <= MEMORY_LIMIT);
        if !fits {
            self.exhausted.set(true);
        }
        fits
    }

    /// Counts the block `ptr` (if allocated) as held.
    fn held(&mut self, ptr: *mut u8) -> *mut u8 {
        if !ptr.is_null() {
            // SAFETY: `ptr` was just allocated by `RustAllocator`.
            self.used += unsafe { RustAllocator::usable_size(ptr) };
        }
        ptr
    }
}

// SAFETY: every block comes from `RustAllocator` and goes back to it; this only
// refuses some requests (returning null, which the trait allows) and counts sizes.
unsafe impl Allocator for LimitedAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        if !self.fits(0, size) {
            return std::ptr::null_mut();
        }
        let ptr = RustAllocator.alloc(size);
        self.held(ptr)
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        if !count.checked_mul(size).is_some_and(|total| self.fits(0, total)) {
            self.exhausted.set(true);
            return std::ptr::null_mut();
        }
        let ptr = RustAllocator.calloc(count, size);
        self.held(ptr)
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        self.used -= RustAllocator::usable_size(ptr);
        RustAllocator.dealloc(ptr);
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        if ptr.is_null() {
            return self.alloc(new_size);
        }
        let old = RustAllocator::usable_size(ptr);
        if !self.fits(old, new_size) {
            return std::ptr::null_mut();
        }
        let moved = RustAllocator.realloc(ptr, new_size);
        if moved.is_null() {
            // The old block is still held.
            return moved;
        }
        self.used -= old;
        self.held(moved)
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize {
        RustAllocator::usable_size(ptr)
    }
}

/// What a script's `host` functions read and record.
struct Host<'a> {
    recorded: &'a Recorded,
    variables: &'a SetVariables,
    globals: &'a GlobalVariables,
    exhausted: &'a Exhausted,
}

/// Evaluates the prelude and calls it with `host` and the exchange's data.
fn install<'js>(ctx: &Ctx<'js>, data: &serde_json::Value, from: &Host) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    let tests = from.recorded.clone();
    host.set(
        "test",
        Function::new(ctx.clone(), move |name: String, passed: bool, message: Option<String>| {
            tests.borrow_mut().tests.push(TestResult { name, passed, message });
        })?,
    )?;
    // A `client.test` whose function threw `thrown`, described as a script's own
    // failure is, unless the runtime has run out of memory since the last report.
    let (tests, exhausted) = (from.recorded.clone(), from.exhausted.clone());
    host.set(
        "testFailed",
        Function::new(ctx.clone(), move |name: String, thrown: Value<'js>| {
            let message = if exhausted.take() { memory_message() } else { thrown_message(&thrown) };
            tests.borrow_mut().tests.push(TestResult { name, passed: false, message: Some(message) });
        })?,
    )?;
    let set = from.variables.clone();
    host.set(
        "setVariable",
        Function::new(ctx.clone(), move |name: String, value: String| {
            set.borrow_mut().insert(name, value);
        })?,
    )?;
    let global = from.globals.clone();
    host.set("globalGet", Function::new(ctx.clone(), move |name: String| global.get(&name))?)?;
    let global = from.globals.clone();
    host.set("globalSet", Function::new(ctx.clone(), move |name: String, value: String| global.set(&name, &value))?)?;
    let global = from.globals.clone();
    host.set("globalClear", Function::new(ctx.clone(), move |name: String| global.remove(&name))?)?;
    let global = from.globals.clone();
    host.set("globalIsEmpty", Function::new(ctx.clone(), move || global.is_empty())?)?;
    let logs = from.recorded.clone();
    let logged = Cell::new(0);
    host.set("log", Function::new(ctx.clone(), move |line: String| log(&mut logs.borrow_mut().logs, &logged, line))?)?;
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
        logs.push(format!("Log stopped at {} KB, the log limit for a script", LOG_LIMIT >> 10));
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

fn memory_message() -> String {
    format!("Stopped at {} MB, the memory limit for a script", MEMORY_LIMIT >> 20)
}

/// The message and line of a script that threw.
fn describe(caught: CaughtError<'_>) -> ScriptError {
    match caught {
        CaughtError::Exception(e) => {
            ScriptError { message: thrown_message(e.as_value()), line: e.stack().as_deref().and_then(script_line) }
        }
        CaughtError::Value(v) => ScriptError { message: thrown_message(&v), line: None },
        CaughtError::Error(e) => ScriptError { message: e.to_string(), line: None },
    }
}

/// What a failure says about the value a script threw, in a test or not: an
/// error's message, after its name unless it's a plain `Error`, a failed
/// `client.assert` or an unsupported API; anything else as text.
fn thrown_message(thrown: &Value<'_>) -> String {
    if let Some(error) = thrown.as_object().filter(|_| thrown.is_error()) {
        let name: Option<String> = error.get("name").ok();
        let message: String = error.get::<_, Option<String>>("message").ok().flatten().unwrap_or_default();
        return match name.as_deref() {
            Some("Error" | "AssertionError" | "UnsupportedApiError") | None => message,
            Some(name) => format!("{name}: {message}"),
        };
    }
    value_text(thrown)
}

/// A thrown value that isn't an error, as text: a string as it is, an object as
/// JSON where it can be, anything else as JavaScript writes it.
fn value_text(v: &Value<'_>) -> String {
    if let Some(s) = v.as_string() {
        return s.to_string().unwrap_or_default();
    }
    let json = || v.ctx().json_stringify(v.clone()).ok().flatten().and_then(|s| s.to_string().ok());
    v.is_object()
        .then(json)
        .flatten()
        .or_else(|| Coerced::<String>::from_js(v.ctx(), v.clone()).ok().map(|s| s.0))
        .unwrap_or_else(|| "Script threw".into())
}

/// The first line of the user's script in a QuickJS stack (`at f (<script>:3:5)`).
fn script_line(stack: &str) -> Option<usize> {
    let at = stack.find(&format!("{SCRIPT_FILE}:"))? + SCRIPT_FILE.len() + 1;
    let digits: String = stack[at..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}
