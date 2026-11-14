//! Pre-request scripts (`< {% … %}`) run before variable substitution, as the
//! shell runs them: their `request.variables.set` values reach `{{name}}` in the
//! request a mock server receives, and a failing script sends nothing.

use std::collections::HashMap;
use std::path::Path;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, prepare, ExecError, ExecSettings};
use httpdesk_core::script::run_pre_request_script;
use httpdesk_core::vars::Resolver;
use httpdesk_core::*;
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(wiremock::matchers::any()).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    server
}

/// Sends the file's first request the way the shell does: its pre-request script
/// with `env`, then the variables (env, File variables, the request's own and the
/// script's), then prepare and execute. The error is the send's, if it failed.
async fn send(server: &MockServer, file: &str, env: &HashMap<String, String>) -> Result<(), ExecError> {
    let file = parse(&file.replace("<server>", &server.uri()));
    let req = &file.requests[0];
    let pre = run_pre_request_script(req, env)?;
    let resolver = Resolver::for_request(env, &file.header.variables, &req.variables, None)
        .with_pre_request_variables(&pre.variables);
    let settings = ExecSettings::default();
    let prepared = prepare(req, &resolver, Path::new("."), &settings)?;
    execute(prepared, &settings, &SslConfig::default()).await?;
    Ok(())
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// The one request the server received.
async fn received(server: &MockServer) -> wiremock::Request {
    let mut all = server.received_requests().await.unwrap();
    assert_eq!(all.len(), 1, "{all:?}");
    all.remove(0)
}

fn header(req: &wiremock::Request, name: &str) -> Option<String> {
    req.headers.get(name).map(|v| v.to_str().unwrap().to_string())
}

fn script_error(e: ExecError) -> (String, Option<usize>) {
    match e {
        ExecError::PreRequestScript { message, line } => (message, line),
        other => panic!("not a pre-request script error: {other:?}"),
    }
}

#[tokio::test]
async fn a_header_built_from_request_variables_set_is_sent() {
    let server = server().await;
    let file = r#"< {%
    const id = "abc";
    request.variables.set("signature", id + "-" + (40 + 2));
%}
POST <server>/signed/{{signature}}
X-Signature: {{signature}}

{"sig": "{{signature}}"}
"#;
    send(&server, file, &env(&[])).await.unwrap();
    let got = received(&server).await;
    assert_eq!(header(&got, "x-signature").as_deref(), Some("abc-42"));
    assert_eq!(got.url.path(), "/signed/abc-42");
    assert_eq!(got.body, br#"{"sig": "abc-42"}"#);
}

#[tokio::test]
async fn the_jetbrains_docs_one_line_example_works() {
    let server = server().await;
    send(&server, "< {% request.variables.set(\"firstname\", \"John\") %}\nGET <server>/{{firstname}}\n", &env(&[]))
        .await
        .unwrap();
    assert_eq!(received(&server).await.url.path(), "/John");
}

#[tokio::test]
async fn request_variables_get_reads_back_what_the_script_set() {
    let server = server().await;
    let file = r#"< {%
    request.variables.set("a", "1");
    request.variables.set("b", request.variables.get("a") + "2");
    request.variables.set("missing", String(request.variables.get("nope")));
    request.variables.set("n", 7);
    request.variables.set("obj", {k: "v"});
%}
GET <server>/x
X-B: {{b}}
X-Missing: {{missing}}
X-N: {{n}}
X-Obj: {{obj}}
"#;
    send(&server, file, &env(&[])).await.unwrap();
    let got = received(&server).await;
    assert_eq!(header(&got, "x-b").as_deref(), Some("12"));
    assert_eq!(header(&got, "x-missing").as_deref(), Some("null"));
    assert_eq!(header(&got, "x-n").as_deref(), Some("7"));
    assert_eq!(header(&got, "x-obj").as_deref(), Some(r#"{"k":"v"}"#));
}

#[tokio::test]
async fn request_environment_get_returns_private_environment_values() {
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("http-client.env.json"), r#"{"dev": {"user": "ada"}}"#).unwrap();
    std::fs::write(ws.path().join("http-client.private.env.json"), r#"{"dev": {"secret": "s3cr3t"}}"#).unwrap();
    let set = env::load_for(ws.path(), ws.path()).unwrap();
    let vars = env::variables(&set, Some("dev"));

    let server = server().await;
    let file = r#"< {%
    request.variables.set("auth", request.environment.get("user") + ":" + request.environment.get("secret"));
    request.variables.set("none", String(request.environment.get("undefinedName")));
%}
GET <server>/x
X-Auth: {{auth}}
X-None: {{none}}
"#;
    send(&server, file, &vars).await.unwrap();
    let got = received(&server).await;
    assert_eq!(header(&got, "x-auth").as_deref(), Some("ada:s3cr3t"));
    assert_eq!(header(&got, "x-none").as_deref(), Some("null"));
}

/// The JetBrains-documented order (env > global > in-place > per-request), until
/// #129 observes Rider's; see `Resolver::with_pre_request_variables`.
#[tokio::test]
async fn a_name_the_environment_file_or_request_defines_wins_over_request_variables_set() {
    let server = server().await;
    let file = r#"@fromFile = file

###
@fromRequest = request
< {%
    for (const n of ["fromEnv", "fromFile", "fromRequest", "fromScript"]) request.variables.set(n, "script");
%}
GET <server>/x
X-Env: {{fromEnv}}
X-File: {{fromFile}}
X-Request: {{fromRequest}}
X-Script: {{fromScript}}
"#;
    send(&server, file, &env(&[("fromEnv", "env")])).await.unwrap();
    let got = received(&server).await;
    let headers: Vec<_> =
        ["x-env", "x-file", "x-request", "x-script"].iter().map(|h| header(&got, h).unwrap_or_default()).collect();
    assert_eq!(headers, ["env", "file", "request", "script"]);
}

#[tokio::test]
async fn a_pre_request_script_value_can_feed_other_variables_and_the_host() {
    let server = server().await;
    let host = server.uri().replace("http://", "");
    let file =
        "@base = {{scheme}}://<host>\n\n###\n< {% request.variables.set(\"scheme\", \"http\") %}\nGET {{base}}/x\n";
    send(&server, &file.replace("<host>", &host), &env(&[])).await.unwrap();
    assert_eq!(received(&server).await.url.path(), "/x");
}

#[tokio::test]
async fn a_failing_pre_request_script_sends_nothing_and_reports_its_line_and_message() {
    let server = server().await;
    let file = "### Signed\n< {%\n    request.variables.set(\"a\", \"1\");\n    missing.call();\n%}\nGET <server>/x\n";
    let (message, line) = script_error(send(&server, file, &env(&[])).await.unwrap_err());
    assert_eq!((message.as_str(), line), ("ReferenceError: missing is not defined", Some(3)));
    assert!(server.received_requests().await.unwrap().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn lines_count_from_the_first_pre_request_line_across_blocks() {
    let server = server().await;
    let file =
        "< {% request.variables.set(\"a\", \"1\") %}\n< {%\n\n  throw new Error(\"no key\");\n%}\nGET <server>/x\n";
    let (message, line) = script_error(send(&server, file, &env(&[])).await.unwrap_err());
    assert_eq!((message.as_str(), line), ("no key", Some(4)));
    let file = "< {% let x = ; %}\nGET <server>/x\n";
    let (message, line) = script_error(send(&server, file, &env(&[])).await.unwrap_err());
    assert_eq!((message.as_str(), line), ("SyntaxError: unexpected token in expression: ';'", Some(1)));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn tests_and_asserts_in_a_pre_request_script_are_results_and_do_not_block_the_send() {
    let server = server().await;
    let file = "< {%\nclient.assert(false, \"needs a token\");\nclient.test(\"ok\", () => {});\n%}\nGET <server>/x\n";
    send(&server, file, &env(&[])).await.unwrap();
    received(&server).await;
    let req = parse(file).requests.remove(0);
    let tests = run_pre_request_script(&req, &env(&[])).unwrap().results.tests;
    let summary: Vec<_> = tests.iter().map(|t| (t.name.as_str(), t.passed, t.message.as_deref())).collect();
    assert_eq!(summary, [("needs a token", false, Some("needs a token")), ("ok", true, None)]);
}

#[tokio::test]
async fn a_pre_request_script_that_loops_forever_is_stopped_and_sends_nothing() {
    let server = server().await;
    let started = std::time::Instant::now();
    let (message, line) =
        script_error(send(&server, "< {% while (true) {} %}\nGET <server>/x\n", &env(&[])).await.unwrap_err());
    assert_eq!((message.as_str(), line), ("Stopped after 5 s, the time limit for a script", None));
    assert!(started.elapsed() < script::TIME_LIMIT * 2);
    let (message, _) = script_error(
        send(
            &server,
            "< {% const a = []; while (true) a.push(new ArrayBuffer(1 << 20)); %}\nGET <server>/x\n",
            &env(&[]),
        )
        .await
        .unwrap_err(),
    );
    assert_eq!(message, "Stopped at 64 MB, the memory limit for a script");
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn unimplemented_request_apis_fail_naming_the_api() {
    let server = server().await;
    let calls = [
        ("request.body.tryGetSubstituted()", "request.body"),
        ("request.headers.findByName(\"a\")", "request.headers"),
        ("request.iteration()", "request.iteration"),
        ("request.variables.set(\"ids\", [1, 2])", "request.variables.set with an array (iterations)"),
        ("crypto.sha256()", "crypto.sha256"),
        ("client.global.set(\"a\", \"b\")", "client.global.set"),
    ];
    for (call, api) in calls {
        let (message, line) =
            script_error(send(&server, &format!("< {{% {call}; %}}\nGET <server>/x\n"), &env(&[])).await.unwrap_err());
        assert_eq!((message, line), (format!("{api} isn't supported in HttpDesk"), Some(1)), "{call}");
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_pre_request_script_file_is_not_supported_yet_and_sends_nothing() {
    let server = server().await;
    let (message, line) = script_error(send(&server, "< ./sign.js\nGET <server>/x\n", &env(&[])).await.unwrap_err());
    assert_eq!(
        (message.as_str(), line),
        ("Pre-request script files (./sign.js) aren't supported in HttpDesk yet", None)
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_request_without_a_pre_request_script_sets_nothing() {
    let req = parse("GET https://example.com\n\n> {% client.test(\"t\", () => {}); %}\n").requests.remove(0);
    let pre = run_pre_request_script(&req, &env(&[])).unwrap();
    assert!(pre.variables.is_empty());
    assert!(pre.results.tests.is_empty());
}

#[tokio::test]
async fn the_response_api_is_not_there_before_the_request_is_sent() {
    let server = server().await;
    let (message, line) =
        script_error(send(&server, "< {% response.status; %}\nGET <server>/x\n", &env(&[])).await.unwrap_err());
    assert_eq!((message.as_str(), line), ("ReferenceError: response is not defined", Some(1)));
}
