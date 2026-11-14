//! Response handlers (`> {% … %}`) run against real responses from a mock server:
//! their `client.test`/`client.assert` results, the sandbox, the limits, and the
//! JetBrains APIs HttpDesk doesn't implement.

use std::collections::HashMap;
use std::path::Path;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, prepare, ExecOutcome, ExecSettings};
use httpdesk_core::script::{run_response_handler, TestResult};
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
    let text = format!("GET {}/{route}\n\n{handler}\n", server.uri());
    let req = parse(&text).requests.remove(0);
    let settings = ExecSettings::default();
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();
    let outcome = execute(prepared, &settings, &SslConfig::default()).await.unwrap();
    let results = run_response_handler(&req, &outcome.response, &outcome.body);
    (req, outcome, results.tests)
}

fn pass(name: &str) -> TestResult {
    TestResult { name: name.into(), passed: true, message: None }
}

fn fail(name: &str, message: &str) -> TestResult {
    TestResult { name: name.into(), passed: false, message: Some(message.into()) }
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
    assert_eq!(tests, [pass("first"), fail("Response handler", "ReferenceError: missing is not defined (line 4)")]);
    assert_eq!(outcome.response.status, 201, "the response is still there");
}

#[tokio::test]
async fn a_syntax_error_is_reported_with_its_line() {
    let server = server().await;
    let (_, _, tests) = run(&server, "user", "> {%\n  let x = ;\n%}").await;
    assert_eq!(tests, [fail("Response handler", "SyntaxError: unexpected token in expression: ';' (line 2)")]);
}

#[tokio::test]
async fn unimplemented_jetbrains_apis_fail_naming_the_api() {
    let server = server().await;
    let calls = [
        ("client.global.set(\"a\", \"b\")", "client.global.set"),
        ("client.global.get(\"a\")", "client.global.get"),
        ("client.log(\"hi\")", "client.log"),
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
        assert_eq!(tests, [fail("Response handler", &format!("{api} isn't supported in HttpDesk (line 1)"))], "{call}");
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
    assert_eq!(tests, [pass("before"), fail("Response handler", "Stopped after 5 s, the time limit for a script")]);
    assert!(took >= script::TIME_LIMIT && took < script::TIME_LIMIT * 2, "{took:?}");
    assert_eq!(outcome.response.status, 201);
}

#[tokio::test]
async fn catching_the_time_limit_does_not_keep_a_script_running() {
    let server = server().await;
    let handler = "> {% for (;;) { try { while (true) {} } catch (e) {} } %}";
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [fail("Response handler", "Stopped after 5 s, the time limit for a script")]);
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
        assert_eq!(tests, [fail("Response handler", "Stopped at 64 MB, the memory limit for a script")], "{grow}");
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

#[tokio::test]
async fn a_script_file_reference_fails_naming_it_and_a_redirect_runs_nothing() {
    let server = server().await;
    let (_, _, tests) = run(&server, "user", "> ./check.js").await;
    assert_eq!(
        tests,
        [fail("Response handler", "Response handler files (./check.js) aren't supported in HttpDesk yet")]
    );
    let (_, _, tests) = run(&server, "user", ">> ./saved.json").await;
    assert_eq!(tests, []);
    let (req, _, tests) = run(&server, "user", "> {% client.assert(true, 'ran'); %}\n>> ./saved.json").await;
    assert_eq!(tests, [pass("ran")]);
    assert!(req.response_handler.unwrap().ends_with(">> ./saved.json"));
}

#[tokio::test]
async fn each_handler_gets_a_fresh_context() {
    let server = server().await;
    run(&server, "user", "> {% globalThis.leftover = 1; Object.prototype.polluted = 1; %}").await;
    let handler = "> {% client.assert(typeof leftover === 'undefined' && ({}).polluted === undefined, 'fresh'); %}";
    let (_, _, tests) = run(&server, "user", handler).await;
    assert_eq!(tests, [pass("fresh")]);
}
