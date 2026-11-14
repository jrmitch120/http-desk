//! Request variables (VS Code REST Client's `{{login.response.body.$.token}}`)
//! against a mock server: a send of a `# @name` request records its exchange in the
//! Session, and later requests in the same file read it. Observed as what the
//! server receives, the way the shell sends (resolve, prepare, execute, record).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exchange;
use httpdesk_core::exec::{self, execute, prepare, ExecError, ExecSettings, HttpResponse};
use httpdesk_core::session::Session;
use httpdesk_core::vars::Resolver;
use httpdesk_core::*;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, Request as Received, ResponseTemplate};

/// The Resolver a send of request `index` of `text` (the file at `file`) gets: its
/// File variables, its own, and the latest exchanges of the file's named requests.
fn resolver(session: &Session, file: &Path, text: &str, index: usize) -> (Request, Resolver) {
    let parsed = parse(text);
    let req = parsed.requests[index].clone();
    let file_vars: Vec<Variable> =
        parsed.header.variables.iter().chain(parsed.requests.iter().flat_map(|r| &r.variables)).cloned().collect();
    let resolver = Resolver::for_request(&HashMap::new(), &file_vars, &req.variables, None)
        .with_request_variables(session.exchanges().for_file(file, &parsed.request_names()));
    (req, resolver)
}

/// Sends request `index` of `text` as the shell does, recording its exchange when it's named.
async fn send(session: &Session, file: &Path, text: &str, index: usize) -> Result<HttpResponse, ExecError> {
    let (req, resolver) = resolver(session, file, text, index);
    let settings = ExecSettings::default();
    let prepared = prepare(&req, &resolver, Path::new("."), &settings)?;
    let pending = exchange::begin(Some(file), &req, &prepared);
    let outcome = execute(prepared, &settings, &SslConfig::default()).await?;
    let body: Arc<[u8]> = outcome.body.into();
    if let Some(pending) = pending {
        pending.finish(session.exchanges(), &outcome.response, body);
    }
    Ok(outcome.response)
}

async fn received(server: &MockServer, at: &str) -> Vec<Received> {
    server.received_requests().await.unwrap().into_iter().filter(|r| r.url.path() == at).collect()
}

fn header<'a>(r: &'a Received, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

/// A server whose `/login` answers `body` as JSON with an `X-Token: from-header` header,
/// and whose `/me` answers 200.
async fn login_server(body: serde_json::Value) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body).insert_header("X-Token", "from-header"))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    server
}

#[tokio::test]
async fn a_token_from_the_login_response_is_sent_in_a_later_header_and_body() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let text = format!(
        "# @name login\n\
         POST {uri}/login\n\
         \n\
         ###\n\
         POST {uri}/me\n\
         Authorization: Bearer {{{{login.response.body.$.token}}}}\n\
         X-Echo: {{{{login.response.headers.x-TOKEN}}}}\n\
         Content-Type: application/json\n\
         \n\
         {{\"token\": \"{{{{login.response.body.$.token}}}}\"}}\n",
        uri = server.uri()
    );
    let session = Session::default();
    let file = Path::new("/ws/api.http");

    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "authorization"), Some("Bearer abc123"));
    assert_eq!(header(&me, "x-echo"), Some("from-header"), "headers match case-insensitively");
    assert_eq!(String::from_utf8_lossy(&me.body), "{\"token\": \"abc123\"}");
}

/// A file whose `login` answers the server's JSON and whose second request sends
/// `X-Token: {{login.response.body.<path>}}` to `/me`.
fn chain(server: &MockServer, path: &str) -> String {
    format!(
        "# @name login\nPOST {uri}/login\n\n###\nGET {uri}/me\nX-Token: {{{{login.response.body.{path}}}}}\n",
        uri = server.uri()
    )
}

#[tokio::test]
async fn a_request_variable_of_a_request_never_sent_blocks_the_send() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();

    let err = send(&session, Path::new("/ws/api.http"), &chain(&server, "$.token"), 1).await.unwrap_err();

    assert!(matches!(&err, ExecError::UnsentRequest(names) if names == &["login"]), "{err:?}");
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["kind"], "unsentRequest");
    assert_eq!(json["details"], serde_json::json!({ "names": ["login"] }));
    assert!(json["message"].as_str().unwrap().contains("`login`"), "{json}");
    assert!(received(&server, "/me").await.is_empty(), "nothing is sent");
    assert!(received(&server, "/login").await.is_empty(), "nor is login sent on its own");
}

#[tokio::test]
async fn an_exchange_belongs_to_its_file() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let text = chain(&server, "$.token");
    send(&session, Path::new("/ws/other.http"), &text, 0).await.unwrap();

    let err = send(&session, Path::new("/ws/api.http"), &text, 1).await.unwrap_err();

    assert!(matches!(&err, ExecError::UnsentRequest(names) if names == &["login"]), "{err:?}");
}

#[tokio::test]
async fn a_path_that_matches_nothing_blocks_the_send_naming_the_exchange() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = chain(&server, "$.tok");
    send(&session, file, &text, 0).await.unwrap();
    let received_at = session.exchanges().latest(file, "login").unwrap().received;

    let err = send(&session, file, &text, 1).await.unwrap_err();

    let ExecError::UnmatchedPath(paths) = &err else { panic!("{err:?}") };
    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].reference, "login.response.body.$.tok");
    assert_eq!(paths[0].request, "login");
    assert_eq!(paths[0].received, received_at);
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["kind"], "unmatchedPath");
    assert_eq!(json["details"]["paths"][0]["request"], "login");
    assert_eq!(
        json["details"]["paths"][0]["received"],
        received_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    let message = json["message"].as_str().unwrap();
    assert!(message.contains("{{login.response.body.$.tok}}") && message.contains("`login`"), "{message}");
    assert!(received(&server, "/me").await.is_empty(), "nothing is sent");
}

#[tokio::test]
async fn a_missing_header_or_a_body_that_isnt_json_matches_nothing() {
    let server = MockServer::start().await;
    Mock::given(path("/login")).respond_with(ResponseTemplate::new(200).set_body_string("plain")).mount(&server).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "# @name login\nGET {uri}/login\n\n###\nGET {uri}/me\nA: {{{{login.response.headers.X-Missing}}}}\nB: {{{{login.response.body.$.token}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();

    let err = send(&session, file, &text, 1).await.unwrap_err();

    let ExecError::UnmatchedPath(paths) = &err else { panic!("{err:?}") };
    let references: Vec<&str> = paths.iter().map(|p| p.reference.as_str()).collect();
    assert_eq!(references, ["login.response.headers.X-Missing", "login.response.body.$.token"]);
}

#[tokio::test]
async fn the_request_as_sent_is_read_with_its_full_body_and_headers() {
    let server = login_server(serde_json::json!({})).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    // Longer than the 64 KB the Request tab previews.
    let long = "x".repeat(70 * 1024);
    let text = format!(
        "# @name login\n\
         POST {uri}/login\n\
         X-Client: cli\n\
         Content-Type: application/json\n\
         \n\
         {{\"user\": \"ann\", \"pad\": \"{long}\"}}\n\
         \n\
         ###\n\
         POST {uri}/me\n\
         X-Client: {{{{login.request.headers.x-client}}}}\n\
         X-User: {{{{login.request.body.$.user}}}}\n\
         \n\
         {{{{login.request.body.*}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let login = received(&server, "/login").await.pop().unwrap();
    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "x-client"), Some("cli"));
    assert_eq!(header(&me, "x-user"), Some("ann"));
    assert_eq!(me.body, login.body, "the whole body as sent");
}

#[tokio::test]
async fn a_string_is_inserted_raw_and_anything_else_as_json_from_the_first_match() {
    let server = MockServer::start().await;
    let body = r#"{"items":[{"id":9007199254740993,"name":"Rex \"the dog\""},{"id":2}],"tags":["a", "b"],"n":null}"#;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "# @name login\nGET {uri}/login\n\n###\nPOST {uri}/me\n\n\
         {{{{login.response.body.$.items[*].id}}}}|{{{{login.response.body.$.items[0].name}}}}|\
         {{{{login.response.body.$.tags}}}}|{{{{login.response.body.$.n}}}}|{{{{login.response.body.*}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&me.body),
        format!("9007199254740993|Rex \"the dog\"|[\"a\", \"b\"]|null|{body}")
    );
}

#[tokio::test]
async fn of_two_requests_sharing_a_name_the_one_sent_last_supplies_the_exchange() {
    let server = MockServer::start().await;
    for (at, token) in [("/a", "from-a"), ("/b", "from-b")] {
        Mock::given(path(at))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "token": token })))
            .mount(&server)
            .await;
    }
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "# @name login\nGET {uri}/a\n\n###\n# @name login\nGET {uri}/b\n\n###\nGET {uri}/me\nX-Token: {{{{login.response.body.$.token}}}}\n",
        uri = server.uri()
    );

    send(&session, file, &text, 1).await.unwrap();
    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 2).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "x-token"), Some("from-a"));
}

#[tokio::test]
async fn a_dotted_reference_never_falls_back_to_a_file_variable() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let text = format!(
        "@login = file-value\n\nGET {uri}/me\nX-Token: {{{{login.response.body.$.token}}}}\nX-Plain: {{{{login}}}}\n",
        uri = server.uri()
    );
    let (req, resolver) = resolver(&session, Path::new("/ws/api.http"), &text, 0);

    let prepared = prepare(&req, &resolver, Path::new("."), &ExecSettings::default()).unwrap();

    assert_eq!(prepared.header("x-token"), Some("{{login.response.body.$.token}}"));
    assert_eq!(prepared.header("x-plain"), Some("file-value"));
    assert_eq!(resolver.undefined(), ["login.response.body.$.token"]);
    assert!(resolver.unsent().is_empty());
}

#[tokio::test]
async fn a_plain_reference_is_the_file_variable_even_when_a_request_has_that_name() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "@login = file-value\n\n# @name login\nPOST {uri}/login\n\n###\nGET {uri}/me\nX-Plain: {{{{login}}}}\nX-Token: {{{{login.response.body.$.token}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "x-plain"), Some("file-value"));
    assert_eq!(header(&me, "x-token"), Some("abc123"));
}

#[tokio::test]
async fn a_name_given_only_by_three_hashes_is_undefined() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "### login\nPOST {uri}/login\n\n###\nGET {uri}/me\nX-Token: {{{{login.response.body.$.token}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();

    let sent = send(&session, file, &text, 1).await.unwrap();

    assert_eq!(sent.warnings, ["Undefined variables: login.response.body.$.token"]);
    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "x-token"), Some("{{login.response.body.$.token}}"));
}

#[tokio::test]
async fn the_resolved_preview_shows_the_value_and_says_what_would_block() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = chain(&server, "$.token");

    let (req, unsent) = resolver(&session, file, &text, 1);
    let shown = exec::preview(&req, unsent);
    assert!(matches!(shown.error, Some(ExecError::UnsentRequest(_))), "{:?}", shown.error);
    assert!(shown.headers.contains(&("X-Token".into(), "{{login.response.body.$.token}}".into())));

    send(&session, file, &text, 0).await.unwrap();
    let (req, sent) = resolver(&session, file, &text, 1);
    let shown = exec::preview(&req, sent);
    assert!(shown.error.is_none(), "{:?}", shown.error);
    assert!(shown.headers.contains(&("X-Token".into(), "abc123".into())), "{:?}", shown.headers);
}

#[tokio::test]
async fn the_rest_client_docs_chain_runs_through_file_variables() {
    let server = MockServer::start().await;
    Mock::given(path("/api/login"))
        .respond_with(ResponseTemplate::new(200).insert_header("X-AuthToken", "tok-1"))
        .mount(&server)
        .await;
    Mock::given(path("/api/comments"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 42 })))
        .mount(&server)
        .await;
    Mock::given(path("/api/comments/42")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let text =
        include_str!("fixtures/vscode.http").replace("https://example.com/api", &format!("{}/api", server.uri()));
    let session = Session::default();
    let file = Path::new("/ws/vscode.http");

    for (i, at) in [(0, "/api/login"), (4, "/api/comments"), (5, "/api/comments/42")] {
        send(&session, file, &text, i).await.unwrap_or_else(|e| panic!("{at}: {e}"));
    }

    let created = received(&server, "/api/comments/42").await.pop().expect("sent to the id the comment got");
    assert_eq!(header(&created, "authorization"), Some("tok-1"));
}
