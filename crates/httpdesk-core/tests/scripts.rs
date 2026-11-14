//! Response handlers (`> {% … %}`) run against real responses from a mock server:
//! their `client.test`/`client.assert` results, the sandbox, the limits, and the
//! JetBrains APIs HttpDesk doesn't implement.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, prepare, ExecOutcome, ExecSettings};
use httpdesk_core::script::{run_pre_request_script, run_response_handler, ScriptContext, ScriptFiles, TestResult};
use httpdesk_core::vars::Resolver;
use httpdesk_core::*;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/user"))
        .respond_with(
            ResponseTemplate::new(201)
                .insert_header("X-Trace", "abc")
                .insert_header("Set-Cookie", "a=1")
                .append_header("Set-Cookie", "b=2")
                .set_body_raw(r#"{"id": 7, "name": "Ada", "tags": ["x", "y"]}"#, "application/json; charset=utf-8"),
        )
        .mount(&server)
        .await;
    Mock::given(path("/text"))
        .respond_with(ResponseTemplate::new(200).set_body_raw("plain words", "text/plain"))
        .mount(&server)
        .await;
    server
}

/// Sends `GET <server>/<route>` followed by `handler`, then runs the handler.
async fn run(server: &MockServer, route: &str, handler: &str) -> (Request, ExecOutcome, Vec<TestResult>) {
    run_in(server, route, handler, &ScriptFiles::default()).await
}

/// [`run`], reading the handler's script files with `files`.
async fn run_in(
    server: &MockServer,
    route: &str,
    handler: &str,
    files: &ScriptFiles,
) -> (Request, ExecOutcome, Vec<TestResult>) {
    let text = format!("GET {}/{route}\n\n{handler}\n", server.uri());
    let req = parse(&text).requests.remove(0);
    let settings = ExecSettings::default();
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();
    let outcome = execute(prepared, &settings, &SslConfig::default()).await.unwrap();
    let results = run_response_handler(
        &req,
        &outcome.response,
        &outcome.body,
        &ScriptContext { files: files.clone(), ..Default::default() },
    );
    (req, outcome, results.tests)
}

fn pass(name: &str) -> TestResult {
    TestResult { name: name.into(), passed: true, message: None, script_error: false }
}

fn fail(name: &str, message: &str) -> TestResult {
    TestResult { name: name.into(), passed: false, message: Some(message.into()), script_error: false }
}

/// The handler's own failure, reported as a failed "Response handler" entry.
fn handler_error(message: &str) -> TestResult {
    TestResult::handler_error(message.into())
}

#[tokio::test]
async fn passing_and_failing_tests_and_asserts_are_reported_with_names_and_messages() {
    let server = server().await;
    let handler = r#"> {%
    client.test("Created", function() {
        client.assert(response.status === 201, "Expected 201");
    });
    client.test("Is Bob", function() {
        client.assert(response.body.name === "Bob", "Name was " + response.body.name);
    });
    client.test("Throws", function() { throw new Error("broken"); });
    client.assert(response.body.id === 7, "id is 7");
    client.assert(false, "never true");
%}"#;
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(
        tests,
        [
            pass("Created"),
            fail("Is Bob", "Name was Ada"),
            fail("Throws", "broken"),
            pass("id is 7"),
            fail("never true", "never true"),
        ]
    );
}

#[tokio::test]
async fn a_thrown_value_reads_the_same_in_a_test_and_at_the_top_level() {
    let server = server().await;
    for (thrown, message) in [
        ("null", "null"),
        ("undefined", "undefined"),
        ("42", "42"),
        ("\"plain words\"", "plain words"),
        ("{ code: 1 }", r#"{"code":1}"#),
        ("new Error(\"broken\")", "broken"),
        ("new TypeError(\"wrong\")", "TypeError: wrong"),
    ] {
        let handler = format!("> {{%\nclient.test(\"t\", () => {{ throw {thrown}; }});\nthrow {thrown};\n%}}");
        let (_, _, tests) = run(&server, "user", &handler).await;
        let at_top = if thrown.starts_with("new ") { format!("{message} (line 3)") } else { message.to_string() };
        assert_eq!(tests, [fail("t", message), handler_error(&at_top)], "throw {thrown}");
    }
}

#[tokio::test]
async fn the_response_api_reads_status_headers_body_and_content_type() {
    let server = server().await;
    let handler = r#"> {%
    client.test("status", () => client.assert(response.status === 201, "status " + response.status));
    client.test("header any case", () => client.assert(response.headers.valueOf("x-trace") === "abc", "valueOf"));
    client.test("missing header", () => client.assert(response.headers.valueOf("Nope") === null, "null"));
    client.test("all values", () => {
        const v = response.headers.valuesOf("set-cookie");
        client.assert(v.length === 2 && v[0] === "a=1" && v[1] === "b=2", JSON.stringify(v));
    });
    client.test("json body", () => client.assert(response.body.tags[1] === "y", typeof response.body));
    client.test("mime", () => client.assert(response.contentType.mimeType === "application/json", "mime"));
    client.test("charset", () => client.assert(response.contentType.charset === "utf-8", "charset"));
%}"#;
    let (_, _, tests) = run(&server, "user", handler).await;
    let names = ["status", "header any case", "missing header", "all values", "json body", "mime", "charset"];
    assert_eq!(tests, names.map(pass));
}

#[tokio::test]
async fn a_text_body_is_a_string() {
    let server = server().await;
    let handler = r#"> {% client.assert(response.body === "plain words", "text body"); %}"#;
    let (_, _, tests) = run(&server, "text", handler).await;
    assert_eq!(tests, [pass("text body")]);
}

#[tokio::test]
async fn a_handler_that_throws_keeps_its_earlier_tests_and_reports_the_handler_line() {
    let server = server().await;
    let handler =
        "> {%\n    client.test(\"first\", () => {});\n\n    missing.call();\n    client.test(\"never\", () => {});\n%}";
    let (_, outcome, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [pass("first"), handler_error("ReferenceError: missing is not defined (line 4)")]);
    assert_eq!(outcome.response.status, 201, "the response is still there");
}

#[tokio::test]
async fn a_syntax_error_is_reported_with_its_line() {
    let server = server().await;
    let (_, _, tests) = run(&server, "user", "> {%\n  let x = ;\n%}").await;
    assert_eq!(tests, [handler_error("SyntaxError: unexpected token in expression: ';' (line 2)")]);
}

#[tokio::test]
async fn unimplemented_jetbrains_apis_fail_naming_the_api() {
    let server = server().await;
    let calls = [
        ("client.global.clearAll()", "client.global.clearAll"),
        ("client.exit()", "client.exit"),
        ("request.variables.get(\"a\")", "request.variables"),
        ("request.environment.get(\"a\")", "request.environment"),
        ("crypto.sha256()", "crypto.sha256"),
        ("$random.uuid", "$random.uuid"),
        ("jsonPath(response.body, \"$.id\")", "jsonPath"),
        ("xpath(response.body, \"/a\")", "xpath"),
    ];
    for (call, api) in calls {
        let (_, _, tests) = run(&server, "user", &format!("> {{% client.test(\"t\", () => {{ {call}; }}); %}}")).await;
        assert_eq!(tests, [fail("t", &format!("{api} isn't supported in HttpDesk"))], "{call}");
        let (_, _, tests) = run(&server, "user", &format!("> {{% {call}; %}}")).await;
        assert_eq!(tests, [handler_error(&format!("{api} isn't supported in HttpDesk (line 1)"))], "{call}");
    }
}

/// Runs each attempt in its own handler, which records a passing test only if
/// the attempt returned, or its promise resolved.
async fn attempts_all_fail(server: &MockServer, attempts: &[String]) {
    for attempt in attempts {
        let handler = format!(
            "> {{%
let r;
try {{ r = (() => {{ {attempt} }})(); }} catch (e) {{ client.test(\"threw\", () => {{ throw e; }}); throw e; }}
if (r && typeof r.then === \"function\") {{
  r.then(() => client.test(\"resolved\", () => {{}}), (e) => client.test(\"rejected\", () => {{ throw e; }}));
}} else {{
  client.test(\"returned\", () => {{}});
}}
%}}"
        );
        let (_, _, tests) = run(server, "user", &handler).await;
        assert!(!tests.is_empty() && tests.iter().all(|t| !t.passed), "{attempt} succeeded: {tests:#?}");
    }
}

#[tokio::test]
async fn scripts_cannot_read_files() {
    let server = server().await;
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "TOP SECRET").unwrap();
    let p = serde_json::to_string(&secret).unwrap();
    let attempts = [
        format!("return require('fs').readFileSync({p}, 'utf8')"),
        format!("return std.loadFile({p})"),
        format!("return std.open({p}, 'r').readAsString()"),
        format!("return os.open({p}, os.O_RDONLY)"),
        format!("return import({p})"),
        "return import('fs')".to_string(),
        "return import('qjs:std')".to_string(),
        format!("return Deno.readTextFileSync({p})"),
    ];
    attempts_all_fail(&server, &attempts).await;
}

#[tokio::test]
async fn scripts_cannot_open_sockets() {
    let server = server().await;
    let url = serde_json::to_string(&format!("{}/leak", server.uri())).unwrap();
    let attempts = [
        format!("return fetch({url})"),
        format!("const x = new XMLHttpRequest(); x.open('GET', {url}); x.send(); return x"),
        format!("return new WebSocket({url})"),
        format!("return require('net').connect(80, {url})"),
        format!("return require('http').get({url})"),
        "return os.socket()".to_string(),
    ];
    attempts_all_fail(&server, &attempts).await;
    let leaked = server.received_requests().await.unwrap().iter().filter(|r| r.url.path() == "/leak").count();
    assert_eq!(leaked, 0);
}

#[tokio::test]
async fn scripts_cannot_spawn_processes() {
    let server = server().await;
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("spawned");
    let m = serde_json::to_string(&marker).unwrap();
    let attempts = [
        format!("return os.exec(['touch', {m}])"),
        format!("return std.popen('touch ' + {m}, 'r')"),
        format!("return require('child_process').execSync('touch ' + {m})"),
        "return process.binding('spawn_sync')".to_string(),
        "return new Worker('x.js')".to_string(),
    ];
    attempts_all_fail(&server, &attempts).await;
    assert!(!marker.exists());
}

#[tokio::test]
async fn a_handler_that_loops_forever_is_stopped_at_the_time_limit_and_the_response_is_kept() {
    let server = server().await;
    let started = std::time::Instant::now();
    let handler = "> {%\nclient.test(\"before\", () => {});\nclient.test(\"spins\", () => { while (true) {} });\n%}";
    let (_, outcome, tests) = run(&server, "user", handler).await;
    let took = started.elapsed();
    assert_eq!(tests, [pass("before"), handler_error("Stopped after 5 s, the time limit for a script")]);
    assert!(took >= script::TIME_LIMIT && took < script::TIME_LIMIT * 2, "{took:?}");
    assert_eq!(outcome.response.status, 201);
}

#[tokio::test]
async fn catching_the_time_limit_does_not_keep_a_script_running() {
    let server = server().await;
    let handler = "> {% for (;;) { try { while (true) {} } catch (e) {} } %}";
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [handler_error("Stopped after 5 s, the time limit for a script")]);
}

#[tokio::test]
async fn a_handler_allocating_without_bound_is_stopped_at_the_memory_limit_and_the_response_is_kept() {
    let server = server().await;
    let grows = [
        "const a = []; while (true) a.push('x'.repeat(1000) + a.length);",
        "const a = []; while (true) a.push(new ArrayBuffer(1 << 20));",
        "let n = 1; while (true) { 'x'.repeat(n).charCodeAt(0); n *= 2; }",
    ];
    for grow in grows {
        let started = std::time::Instant::now();
        let (_, outcome, tests) = run(&server, "user", &format!("> {{% {grow} %}}")).await;
        assert_eq!(tests, [handler_error("Stopped at 64 MB, the memory limit for a script")], "{grow}");
        assert!(started.elapsed() < script::TIME_LIMIT, "stopped by memory, not time");
        assert_eq!(outcome.response.status, 201);
    }
}

#[tokio::test]
async fn running_out_of_memory_inside_a_test_fails_that_test() {
    let server = server().await;
    let handler = "> {%\nclient.test(\"hog\", () => { const a = []; while (true) a.push(new Array(100000).fill(1)); });\nclient.test(\"after\", () => {});\n%}";
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [fail("hog", "Stopped at 64 MB, the memory limit for a script"), pass("after")]);
}

/// A workspace `<tmp>/ws` (canonical, as the shell opens one) with an `api/`
/// folder for the `.http` file, and the [`ScriptFiles`] of a file in `api/`.
/// `<tmp>` itself is outside the workspace.
fn workspace() -> (tempfile::TempDir, PathBuf, ScriptFiles) {
    let outer = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(outer.path()).unwrap().join("ws");
    std::fs::create_dir_all(root.join("api")).unwrap();
    let files = ScriptFiles::new(Some(&root), &root.join("api"));
    (outer, root, files)
}

#[tokio::test]
async fn a_handler_file_next_to_the_http_file_runs_and_its_tests_show() {
    let server = server().await;
    let (_outer, root, files) = workspace();
    let source =
        "client.test(\"Created\", function () {\n  client.assert(response.status === 201, \"not 201\");\n});\n";
    std::fs::write(root.join("api/check.js"), source).unwrap();
    for reference in ["./check.js", "check.js"] {
        let (_, _, tests) = run_in(&server, "user", &format!("> {reference}"), &files).await;
        assert_eq!(tests, [pass("Created")], "{reference}");
    }
    // Its own errors name the file and its line.
    std::fs::create_dir(root.join("scripts")).unwrap();
    std::fs::write(root.join("scripts/fail.js"), "client.test(\"ok\", () => {});\n\nmissing.call();\n").unwrap();
    let (_, _, tests) = run_in(&server, "user", "> ../scripts/fail.js", &files).await;
    assert_eq!(
        tests,
        [pass("ok"), handler_error("ReferenceError: missing is not defined (../scripts/fail.js line 3)")]
    );
}

#[tokio::test]
async fn a_missing_handler_file_or_one_outside_the_workspace_is_a_failed_test_and_a_redirect_runs_nothing() {
    let server = server().await;
    let (outer, root, files) = workspace();
    std::fs::write(outer.path().join("outside.js"), "client.test(\"ran\", () => {});").unwrap();
    std::fs::create_dir(root.join("api/lib.js")).unwrap();
    let cases = [
        ("./missing.js", "Script file ./missing.js doesn't exist"),
        ("../../outside.js", "Script file ../../outside.js is outside the workspace"),
        ("../../nowhere.js", "Script file ../../nowhere.js is outside the workspace"),
        ("./lib.js", "Script file ./lib.js isn't a file"),
    ];
    for (reference, message) in cases {
        let (_, _, tests) = run_in(&server, "user", &format!("> {reference}"), &files).await;
        assert_eq!(tests, [handler_error(message)], "{reference}");
    }
    // A later script still runs.
    let (_, _, tests) = run_in(&server, "user", "> ./missing.js\n> {% client.assert(true, 'after'); %}", &files).await;
    assert_eq!(tests, [handler_error("Script file ./missing.js doesn't exist"), pass("after")]);

    // Without a workspace there is nowhere to read it from.
    let (_, _, tests) = run(&server, "user", "> ./check.js").await;
    assert_eq!(tests, [handler_error("Script file ./check.js can't be read: no workspace is open")]);

    let (_, _, tests) = run_in(&server, "user", ">> ./saved.json", &files).await;
    assert_eq!(tests, []);
    let (req, _, tests) = run_in(&server, "user", "> {% client.assert(true, 'ran'); %}\n>> ./saved.json", &files).await;
    assert_eq!(tests, [pass("ran")]);
    assert!(req.response_handler.unwrap().ends_with(">> ./saved.json"));
    assert!(!root.join("api/saved.json").exists() && !root.join("saved.json").exists());
}

#[tokio::test]
async fn a_response_redirect_sends_normally_and_the_send_and_the_preview_note_that_it_isnt_run() {
    let server = server().await;
    let (_outer, root, files) = workspace();
    let note = |redirect: &str| {
        format!("HttpDesk doesn't run response redirects: {redirect} doesn't save the response to a file.")
    };
    let (req, outcome, tests) =
        run_in(&server, "user", "> {% client.assert(true, 'ran'); %}\n>> out.json\n>>! ./saved.json", &files).await;
    assert_eq!(outcome.response.status, 201);
    assert_eq!(tests, [pass("ran")]);
    assert_eq!(outcome.response.warnings, [note(">> out.json"), note(">>! ./saved.json")]);
    let preview = exec::preview(&req, Resolver::new(HashMap::new()));
    assert_eq!(preview.warnings, [note(">> out.json"), note(">>! ./saved.json")]);
    let written: Vec<_> = walk(&root);
    assert!(written.iter().all(|p| !p.ends_with("out.json") && !p.ends_with("saved.json")), "{written:?}");

    let (_, outcome, _) = run_in(&server, "user", "> {% client.assert(true, 'ran'); %}", &files).await;
    assert_eq!(outcome.response.warnings, Vec::<String>::new());
}

/// Every path below `dir`.
fn walk(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .flat_map(|e| {
            let path = e.unwrap().path();
            let below = if path.is_dir() { walk(&path) } else { Vec::new() };
            std::iter::once(path).chain(below)
        })
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn a_handler_file_symlinked_to_outside_the_workspace_is_refused() {
    let server = server().await;
    let (outer, root, files) = workspace();
    std::fs::write(outer.path().join("outside.js"), "client.test(\"ran\", () => {});").unwrap();
    std::os::unix::fs::symlink(outer.path().join("outside.js"), root.join("api/link.js")).unwrap();
    std::os::unix::fs::symlink(outer.path(), root.join("up")).unwrap();
    for reference in ["./link.js", "../up/outside.js"] {
        let (_, _, tests) = run_in(&server, "user", &format!("> {reference}"), &files).await;
        let message = format!("Script file {reference} is outside the workspace");
        assert_eq!(tests, [handler_error(&message)], "{reference}");
    }
    // A link to a file inside the workspace is fine.
    std::fs::write(root.join("real.js"), "client.test(\"linked\", () => {});").unwrap();
    std::os::unix::fs::symlink(root.join("real.js"), root.join("api/inside.js")).unwrap();
    let (_, _, tests) = run_in(&server, "user", "> inside.js", &files).await;
    assert_eq!(tests, [pass("linked")]);
}

#[tokio::test]
async fn each_handler_gets_a_fresh_context() {
    let server = server().await;
    run(&server, "user", "> {% globalThis.leftover = 1; Object.prototype.polluted = 1; %}").await;
    let handler = "> {% client.assert(typeof leftover === 'undefined' && ({}).polluted === undefined, 'fresh'); %}";
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [pass("fresh")]);
}

/// Visits every member of the script globals and reports, as the name of a
/// last test, the paths that work: values, and functions that don't throw
/// "not supported" when called. Wrapped as a handler or a pre-request script.
const IMPLEMENTED: &str = r#"
const found = [];
function visit(path, value) {
  if (typeof value === "function") {
    try { value(); } catch (e) { if (e.name === "UnsupportedApiError") return; }
    found.push(path);
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      let member;
      try { member = value[key]; } catch (e) { continue; }
      visit(path + "." + key, member);
    }
  } else {
    found.push(path);
  }
}
// A pre-request script has no `response` at all.
for (const root of ["client", "request", "response", "crypto", "$random", "jsonPath", "xpath"]) {
  if (globalThis[root] !== undefined) visit(root, globalThis[root]);
}
client.test(JSON.stringify(found.sort()), function () {});
"#;

/// The Scripts editor completes the API listed in `src/script/api.json`, so it
/// must name exactly what the prelude implements: an API a ticket implements is
/// listed there too, and nothing unsupported is offered. Completion offers
/// `response.*` only in a response handler and `request.*` only in a pre-request
/// script (`src/lib/scriptApi.ts`), so each kind is checked against that share.
#[tokio::test]
async fn the_script_api_list_names_exactly_what_the_prelude_implements() {
    let listed: serde_json::Value = serde_json::from_str(include_str!("../src/script/api.json")).unwrap();
    let mut listed: Vec<&str> = listed.as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    listed.sort_unstable();
    let listed_without =
        |prefix: &str| -> Vec<&str> { listed.iter().copied().filter(|n| !n.starts_with(prefix)).collect() };

    let server = server().await;
    let (_, _, tests) = run(&server, "text", &format!("> {{%{IMPLEMENTED}%}}")).await;
    let in_handler: Vec<String> = serde_json::from_str(&tests.last().unwrap().name).unwrap();
    assert_eq!(in_handler, listed_without("request."));

    let req = parse(&format!("< {{%{IMPLEMENTED}%}}\nGET {}/text\n", server.uri())).requests.remove(0);
    let pre = run_pre_request_script(&req, &HashMap::new(), &ScriptContext::default()).unwrap();
    let in_pre_request: Vec<String> = serde_json::from_str(&pre.results.tests.last().unwrap().name).unwrap();
    assert_eq!(in_pre_request, listed_without("response."));
}

/// Sends `GET <server>/<route>` followed by `handler`, then runs the handler for everything it reported.
async fn results(server: &MockServer, route: &str, handler: &str) -> script::ScriptResults {
    let text = format!("GET {}/{route}\n\n{handler}\n", server.uri());
    let req = parse(&text).requests.remove(0);
    let settings = ExecSettings::default();
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();
    let outcome = execute(prepared, &settings, &SslConfig::default()).await.unwrap();
    run_response_handler(&req, &outcome.response, &outcome.body, &ScriptContext::default())
}

#[tokio::test]
async fn client_log_lines_are_kept_in_order_as_text() {
    let server = server().await;
    let handler = r#"> {%
    client.log("Status " + response.status);
    client.test("logs inside a test too", () => client.log(response.body.tags));
    client.log({ id: response.body.id }, 2, null, undefined, true);
    client.log();
%}"#;
    let results = results(&server, "user", handler).await;
    assert_eq!(results.logs, ["Status 201", r#"["x","y"]"#, r#"{"id":7} 2 null undefined true"#, ""]);
    assert_eq!(results.tests, [pass("logs inside a test too")]);
}

#[tokio::test]
async fn lines_logged_before_a_handler_fails_are_kept() {
    let server = server().await;
    let handler = "> {%\n  client.log(\"before\");\n  missing();\n  client.log(\"never\");\n%}";
    let results = results(&server, "user", handler).await;
    assert_eq!(results.logs, ["before"]);
    assert_eq!(results.tests, [handler_error("ReferenceError: missing is not defined (line 3)")]);
}

#[tokio::test]
async fn a_value_that_cannot_be_written_as_json_is_logged_as_text() {
    let server = server().await;
    let handler = r#"> {%
    const loop = {}; loop.self = loop;
    client.log(loop, () => 1, Symbol("s"), 10n);
%}"#;
    let results = results(&server, "user", handler).await;
    assert_eq!(results.logs, ["[object Object] () => 1 Symbol(s) 10"]);
    assert_eq!(results.tests, []);
}

#[tokio::test]
async fn logging_without_bound_stops_at_the_log_limit_and_says_so() {
    let server = server().await;
    let handler = "> {% const line = 'x'.repeat(1000); for (let i = 0; i < 5000; i++) client.log(line); client.assert(true, 'ran on'); %}";
    let results = results(&server, "user", handler).await;
    let kept: usize = results.logs.iter().map(String::len).sum();
    assert!(kept <= script::LOG_LIMIT + 100, "{kept}");
    assert_eq!(results.logs.last().unwrap(), "Log stopped at 64 KB, the log limit for a script");
    assert_eq!(results.logs.iter().filter(|l| l.starts_with("Log stopped")).count(), 1);
    assert_eq!(results.tests, [pass("ran on")]);
}
