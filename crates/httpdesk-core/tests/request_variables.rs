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

// ---------------------------------------------------------------- the Session panel's Named exchanges

#[tokio::test]
async fn named_exchanges_lists_each_latest_exchange_with_its_file_status_and_time() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    Mock::given(path("/gone")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
    let session = Session::default();
    let (api, other) = (Path::new("/ws/b/api.http"), Path::new("/ws/a/other.http"));
    send(&session, api, &chain(&server, "$.token"), 0).await.unwrap();
    send(&session, other, &format!("# @name zeta\nGET {}/gone\n", server.uri()), 0).await.unwrap();
    send(&session, other, &chain(&server, "$.token"), 0).await.unwrap();

    let list = session.exchanges().list();

    let entries: Vec<_> = list.iter().map(|e| (e.file.as_path(), e.name.as_str(), e.status)).collect();
    assert_eq!(entries, [(other, "login", 200), (other, "zeta", 404), (api, "login", 200)], "by file, then name");
    assert_eq!(list[2].received, session.exchanges().latest(api, "login").unwrap().received);
    let json = serde_json::to_value(&list[2]).unwrap();
    assert_eq!(json["name"], "login");
    assert_eq!(json["status"], 200);
    assert_eq!(json["received"], list[2].received.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
}

#[tokio::test]
async fn removing_a_named_exchange_makes_its_request_variables_unsent_again() {
    let server = login_server(serde_json::json!({ "token": "abc123" })).await;
    let session = Session::default();
    let (api, other) = (Path::new("/ws/api.http"), Path::new("/ws/other.http"));
    let text = chain(&server, "$.token");
    send(&session, api, &text, 0).await.unwrap();
    send(&session, other, &text, 0).await.unwrap();

    assert!(session.exchanges().remove(api, "login"));
    assert!(!session.exchanges().remove(api, "login"), "nothing left to remove");

    let err = send(&session, api, &text, 1).await.unwrap_err();
    assert!(matches!(&err, ExecError::UnsentRequest(names) if names == &["login"]), "{err:?}");
    send(&session, other, &text, 1).await.expect("the other file's exchange stays");
    assert_eq!(session.exchanges().list().len(), 1);
}

// ---------------------------------------------------------------- the hover

#[tokio::test]
async fn a_request_variable_reads_as_unsent_its_value_or_why_it_matches_nothing() {
    use exchange::Reading;
    let server = login_server(serde_json::json!({ "token": "abc123", "n": 7 })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let read = |reference: &str| session.exchanges().read(file, reference);

    assert_eq!(read("login.response.body.$.token"), Some(Reading::Unsent { request: "login".into() }));
    assert_eq!(read("login"), None, "a plain name is never a Request variable");

    send(&session, file, &chain(&server, "$.token"), 0).await.unwrap();
    let received = session.exchanges().latest(file, "login").unwrap().received;

    assert_eq!(
        read("login.response.body.$.token"),
        Some(Reading::Value { request: "login".into(), status: 200, received, value: "abc123".into() })
    );
    let Some(Reading::Value { value, .. }) = read("login.response.headers.x-token") else { panic!() };
    assert_eq!(value, "from-header");
    let Some(Reading::Value { value, .. }) = read("login.response.body.$.n") else { panic!() };
    assert_eq!(value, "7", "as the send inserts it");
    assert_eq!(
        read("login.response.body.$.tok"),
        Some(Reading::Unmatched {
            request: "login".into(),
            status: 200,
            received,
            reason: "`$.tok` matches nothing".into()
        })
    );
    let json = serde_json::to_value(read("login.response.body.$.tok")).unwrap();
    assert_eq!(json["state"], "unmatched");
    assert_eq!(json["received"], received.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
}

#[tokio::test]
async fn a_long_value_reads_shortened_for_the_hover() {
    let long = "x".repeat(exchange::READING_LIMIT + 50);
    let server = login_server(serde_json::json!({ "token": long })).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    send(&session, file, &chain(&server, "$.token"), 0).await.unwrap();

    let Some(exchange::Reading::Value { value, .. }) = session.exchanges().read(file, "login.response.body.$.token")
    else {
        panic!()
    };
    assert_eq!(value.chars().count(), exchange::READING_LIMIT + 1);
    assert!(value.ends_with('…'), "{value}");
}

#[tokio::test]
async fn the_latest_exchanges_shape_lists_each_sides_json_keys_and_header_names_for_completion() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(
            ResponseTemplate::new(201)
                .set_body_raw(r#"{"token":"t","user":{"id":1,"roles":[{"name":"admin"}]}}"#, "application/json")
                .insert_header("X-Token", "a")
                .append_header("x-token", "b"),
        )
        .mount(&server)
        .await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "# @name login\nPOST {uri}/login\nX-Client: cli\nContent-Type: application/json\n\n{{\"user\": \"ann\"}}\n",
        uri = server.uri()
    );
    assert!(session.exchanges().latest(file, "login").is_none());
    let before = chrono::Utc::now();
    send(&session, file, &text, 0).await.unwrap();

    let shape = session.exchanges().latest(file, "login").unwrap().shape();
    assert_eq!(shape.status, 201);
    assert!(shape.received >= before);
    let json = serde_json::to_value(&shape).unwrap();
    assert_eq!(
        json["response"]["body"],
        serde_json::json!({ "keys": [
            ["token", {}],
            ["user", { "keys": [["id", {}], ["roles", { "items": { "keys": [["name", {}]] } }]] }],
        ] })
    );
    let response_headers = json["response"]["headers"].as_array().unwrap();
    let tokens = response_headers.iter().filter(|h| h.as_str().unwrap().eq_ignore_ascii_case("x-token")).count();
    assert_eq!(tokens, 1, "each name once: {response_headers:?}");
    assert!(response_headers.contains(&serde_json::json!("content-type")), "{response_headers:?}");
    assert_eq!(json["request"]["body"], serde_json::json!({ "keys": [["user", {}]] }));
    assert!(json["request"]["headers"].as_array().unwrap().contains(&serde_json::json!("X-Client")), "{json}");
    assert!(json["received"].as_str().unwrap().ends_with('Z'), "{json}");
}

#[tokio::test]
async fn a_body_that_isnt_json_has_no_shape_but_its_headers_are_listed() {
    let server = MockServer::start().await;
    Mock::given(path("/login")).respond_with(ResponseTemplate::new(200).set_body_string("ok")).mount(&server).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    send(&session, file, &format!("# @name login\nGET {}/login\n", server.uri()), 0).await.unwrap();

    let json = serde_json::to_value(session.exchanges().latest(file, "login").unwrap().shape()).unwrap();
    assert_eq!(json["response"]["body"], serde_json::Value::Null);
    assert!(!json["response"]["headers"].as_array().unwrap().is_empty());
    assert_eq!(json["request"]["body"], serde_json::Value::Null, "nothing was sent in the body");
}

/// A server whose `/login` answers `body` with content type `content_type`, and whose `/me` answers 200.
async fn raw_login_server(body: &str, content_type: &str) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body.to_string(), content_type))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    server
}

#[tokio::test]
async fn a_token_from_an_xml_login_response_is_sent_by_xpath() {
    let server = raw_login_server("<login><token>abc123</token></login>", "application/xml").await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = chain(&server, "//token");

    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "x-token"), Some("abc123"));
}

#[tokio::test]
async fn an_xpath_that_matches_nothing_blocks_the_send_naming_the_exchange() {
    let server = raw_login_server("<login><token>abc123</token></login>", "application/xml").await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = chain(&server, "//tok");
    send(&session, file, &text, 0).await.unwrap();

    let err = send(&session, file, &text, 1).await.unwrap_err();

    let ExecError::UnmatchedPath(paths) = &err else { panic!("{err:?}") };
    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].reference, "login.response.body.//tok");
    assert_eq!(paths[0].request, "login");
    assert_eq!(paths[0].reason, "`//tok` matches nothing");
    assert!(received(&server, "/me").await.is_empty(), "nothing is sent");
}

/// Why `{{login.response.body.<path>}}` reads nothing from a login answering `body` as `content_type`.
async fn unmatched_reason(body: &str, content_type: &str, path: &str) -> String {
    let server = raw_login_server(body, content_type).await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = chain(&server, path);
    send(&session, file, &text, 0).await.unwrap();
    match send(&session, file, &text, 1).await {
        Err(ExecError::UnmatchedPath(paths)) => paths[0].reason.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_jsonpath_into_xml_or_an_xpath_into_json_says_which_the_body_wants() {
    let xml = "<login><token>abc123</token></login>";
    let json = r#"{"token": "abc123"}"#;

    assert_eq!(
        unmatched_reason(xml, "application/xml", "$.token").await,
        "the body is XML (`application/xml`), so it takes an XPath, not the JSONPath `$.token`"
    );
    assert_eq!(
        unmatched_reason(json, "application/json", "//token").await,
        "the body is JSON (`application/json`), so it takes a JSONPath starting with `$`, not `//token`"
    );
    let reason = unmatched_reason("plain text", "text/plain", "//token").await;
    assert!(reason.starts_with("the body isn't valid XML"), "{reason}");
}

#[tokio::test]
async fn as_json_or_as_xml_reads_a_body_whose_content_type_says_otherwise() {
    for (body, content_type, path) in [
        (r#"{"token": "abc123"}"#, "application/xml", "asJson.$.token"),
        ("<login><token>abc123</token></login>", "application/json", "asXml.//token"),
    ] {
        let server = raw_login_server(body, content_type).await;
        let session = Session::default();
        let file = Path::new("/ws/api.http");
        let text = chain(&server, path);

        send(&session, file, &text, 0).await.unwrap();
        send(&session, file, &text, 1).await.unwrap_or_else(|e| panic!("{path}: {e}"));

        let me = received(&server, "/me").await.pop().unwrap();
        assert_eq!(header(&me, "x-token"), Some("abc123"), "{path}");
    }
}

#[tokio::test]
async fn an_xpath_inserts_an_elements_content_as_xml_and_any_other_nodes_value() {
    let xml = r#"<?xml version="1.0"?>
<comments xmlns:x="urn:x"><comment id="7">Hi &amp; bye<b>!</b></comment><x:note x:by="ann">n</x:note><empty/></comments>"#;
    let server = raw_login_server(xml, "text/xml; charset=utf-8").await;
    let session = Session::default();
    let file = Path::new("/ws/api.http");
    let text = format!(
        "# @name login\nGET {uri}/login\n\n###\nPOST {uri}/me\n\n\
         {{{{login.response.body.//comment/@id}}}}|{{{{login.response.body.//comment/text()}}}}|\
         {{{{login.response.body.//comment}}}}|{{{{login.response.body.count(//comment/following-sibling::*)}}}}|\
         {{{{login.response.body.string(//missing)}}}}|{{{{login.response.body.//empty}}}}|\
         {{{{login.response.body./}}}}\n",
        uri = server.uri()
    );
    send(&session, file, &text, 0).await.unwrap();
    send(&session, file, &text, 1).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&me.body),
        "7|Hi & bye|Hi &amp; bye<b>!</b>|2||\
         |<comments xmlns:x=\"urn:x\"><comment id=\"7\">Hi &amp; bye<b>!</b></comment><x:note x:by=\"ann\">n</x:note><empty/></comments>"
    );
}
