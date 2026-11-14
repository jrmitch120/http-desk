//! Global variables (`client.global`), sent the way every send goes (`send::send`)
//! against a mock server: what a script stores reaches `{{name}}` in later requests of
//! the workspace, in any file, at the precedence measured with `ijhttp` (#129,
//! `docs/research/http-comment-compat.md` Q6).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use httpdesk_core::exec::{ClientPool, ExecError, ExecSettings};
use httpdesk_core::send::{self, Outgoing, Scripts, SendContext, Sent};
use httpdesk_core::session::Session;
use httpdesk_core::*;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, Request as Received, ResponseTemplate};

/// A mock server that answers `/login` with a token and anything else with 200.
async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "token": "abc123" })))
        .mount(&server)
        .await;
    Mock::given(wiremock::matchers::any()).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    server
}

fn context(root: Option<&Path>, session: &Arc<Session>) -> SendContext {
    SendContext {
        root: root.map(Path::to_path_buf),
        environment: Some("dev".into()),
        settings: ExecSettings::default(),
        scripts: Scripts::Run,
        session: session.clone(),
        clients: ClientPool::default(),
    }
}

/// Sends request `index` of `text`, the file at `file`, in `ctx`, under request key `key`.
async fn send_one(ctx: &SendContext, file: &Path, text: &str, index: usize) -> Result<Sent, ExecError> {
    let mut out = Outgoing::all_in(file, &parse(text)).remove(index);
    out.request_key = Some(format!("{}#{index}", file.display()));
    send::send(ctx, out, |_| {}).await
}

async fn received(server: &MockServer, at: &str) -> Vec<Received> {
    server.received_requests().await.unwrap().into_iter().filter(|r| r.url.path() == at).collect()
}

fn header(r: &Received, name: &str) -> Option<String> {
    r.headers.get(name).map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn a_token_stored_by_logins_handler_is_sent_by_a_later_request_in_the_same_file_and_in_another() {
    let server = server().await;
    let session = Arc::new(Session::default());
    let ctx = context(None, &session);
    let auth = format!(
        "### Login\nPOST {uri}/login\n\n> {{% client.global.set(\"token\", response.body.token) %}}\n\n\
         ### Me\nGET {uri}/me\nAuthorization: Bearer {{{{token}}}}\n",
        uri = server.uri()
    );
    let users = format!("GET {uri}/users\nAuthorization: Bearer {{{{token}}}}\n", uri = server.uri());

    send_one(&ctx, Path::new("/ws/auth.http"), &auth, 0).await.unwrap();
    send_one(&ctx, Path::new("/ws/auth.http"), &auth, 1).await.unwrap();
    send_one(&ctx, Path::new("/ws/api/users.http"), &users, 0).await.unwrap();

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "authorization").as_deref(), Some("Bearer abc123"));
    let users = received(&server, "/users").await.pop().unwrap();
    assert_eq!(header(&users, "authorization").as_deref(), Some("Bearer abc123"));
    assert_eq!(session.globals().get("token").as_deref(), Some("abc123"));
}

#[tokio::test]
async fn a_set_global_variable_is_not_an_undefined_variable() {
    let server = server().await;
    let session = Arc::new(Session::default());
    let ctx = context(None, &session);
    let text = format!("GET {uri}/x?id={{{{id}}}}\n", uri = server.uri());

    let before = send_one(&ctx, Path::new("/ws/a.http"), &text, 0).await.unwrap();
    session.globals().set("id", "7");
    let after = send_one(&ctx, Path::new("/ws/a.http"), &text, 0).await.unwrap();

    assert!(before.response.warnings.iter().any(|w| w.contains("Undefined variables: id")), "{:?}", before.response);
    assert!(!after.response.warnings.iter().any(|w| w.contains("Undefined")), "{:?}", after.response.warnings);
}

#[tokio::test]
async fn scripts_read_clear_and_test_global_variables_across_sends() {
    let server = server().await;
    let session = Arc::new(Session::default());
    let ctx = context(None, &session);
    let text = format!(
        "### first\nGET {uri}/a\n\n> {{%\n\
           client.test(\"empty at first\", () => client.assert(client.global.isEmpty()));\n\
           client.test(\"unset is null\", () => client.assert(client.global.get(\"a\") === null));\n\
           client.global.set(\"a\", \"1\");\n\
           client.global.set(\"b\", {{ n: 2 }});\n\
           client.global.set(\"c\", 3);\n\
           client.test(\"read back at once\", () => client.assert(client.global.get(\"a\") === \"1\"));\n\
         %}}\n\n\
         ### second\nGET {uri}/b\n\n> {{%\n\
           client.test(\"kept\", () => client.assert(client.global.get(\"b\") === '{{\"n\":2}}'));\n\
           client.global.clear(\"a\");\n\
           client.test(\"cleared\", () => client.assert(client.global.get(\"a\") === null && !client.global.isEmpty()));\n\
         %}}\n",
        uri = server.uri()
    );

    let first = send_one(&ctx, Path::new("/ws/a.http"), &text, 0).await.unwrap();
    let second = send_one(&ctx, Path::new("/ws/a.http"), &text, 1).await.unwrap();

    let failed = |sent: &Sent| sent.response.tests.iter().filter(|t| !t.passed).cloned().collect::<Vec<_>>();
    assert_eq!((failed(&first), first.response.tests.len()), (vec![], 3));
    assert_eq!((failed(&second), second.response.tests.len()), (vec![], 2));
    let left: Vec<(String, String)> = session.globals().list().into_iter().collect();
    assert_eq!(left, [("b".to_string(), r#"{"n":2}"#.to_string()), ("c".to_string(), "3".to_string())]);
}

#[tokio::test]
async fn a_handler_that_throws_keeps_the_global_variables_it_set_before_the_throw() {
    let server = server().await;
    let session = Arc::new(Session::default());
    let ctx = context(None, &session);
    let text = format!(
        "POST {uri}/login\n\n> {{%\n  client.global.set(\"token\", response.body.token);\n  missing();\n  client.global.set(\"after\", \"x\");\n%}}\n",
        uri = server.uri()
    );

    let sent = send_one(&ctx, Path::new("/ws/a.http"), &text, 0).await.unwrap();

    assert!(sent.response.tests.iter().any(|t| !t.passed), "the handler's error is a failed test");
    assert_eq!(session.globals().get("token").as_deref(), Some("abc123"));
    assert_eq!(session.globals().get("after"), None);
}

#[tokio::test]
async fn a_pre_request_script_reads_and_sets_global_variables_and_its_own_request_uses_them() {
    let server = server().await;
    let session = Arc::new(Session::default());
    session.globals().set("count", "1");
    let ctx = context(None, &session);
    let text = format!(
        "< {{% client.global.set(\"count\", String(Number(client.global.get(\"count\")) + 1)) %}}\nGET {uri}/x\nX-Count: {{{{count}}}}\n",
        uri = server.uri()
    );

    send_one(&ctx, Path::new("/ws/a.http"), &text, 0).await.unwrap();

    let got = received(&server, "/x").await.pop().unwrap();
    assert_eq!(header(&got, "x-count").as_deref(), Some("2"));
    assert_eq!(session.globals().get("count").as_deref(), Some("2"));
}

#[tokio::test]
async fn a_global_variable_lasts_only_as_long_as_its_session() {
    let server = server().await;
    let text = format!(
        "POST {uri}/login\n\n> {{% client.global.set(\"token\", response.body.token) %}}\n",
        uri = server.uri()
    );
    let session = Arc::new(Session::default());
    send_one(&context(None, &session), Path::new("/ws/a.http"), &text, 0).await.unwrap();

    assert!(Session::default().globals().is_empty(), "another workspace's Session starts with none");
    session.clear();
    assert!(session.globals().is_empty(), "Clear session clears them");
}

/// The places `v` can be defined, as in the research's 63 runs.
#[derive(Debug, Clone, Copy, PartialEq)]
enum DefinedIn {
    Public,
    Private,
    Global,
    InPlace,
    PreRequest,
    Prompt,
}

use DefinedIn::*;

/// What a `probe` request sends as `{{v}}`, with `v` defined in each of `places`, the way
/// the research's scenario files define it (Appendix D). The prompt is answered `prompt`.
async fn probe(places: &[DefinedIn]) -> String {
    let server = server().await;
    let root = tempfile::tempdir().unwrap();
    let env_file = |place, value: &str| {
        if places.contains(&place) {
            serde_json::json!({ "dev": { "v": value } })
        } else {
            serde_json::json!({ "dev": { "unused": "unused" } })
        }
    };
    std::fs::write(root.path().join(env::ENV_FILE), env_file(Public, "env-public").to_string()).unwrap();
    std::fs::write(root.path().join(env::PRIVATE_ENV_FILE), env_file(Private, "env-private").to_string()).unwrap();

    let uri = server.uri();
    let mut text = String::new();
    if places.contains(&InPlace) {
        text += "@v = in-place\n\n";
    }
    text += &format!("### setup\nGET {uri}/setup\n\n");
    if places.contains(&Global) {
        text += "> {%\n    client.global.set(\"v\", \"global\");\n%}\n\n";
    }
    text += "### probe\n";
    if places.contains(&Prompt) {
        text += "# @prompt v\n";
    }
    if places.contains(&PreRequest) {
        text += "< {%\n    request.variables.set(\"v\", \"per-request\");\n%}\n";
    }
    text += &format!("GET {uri}/probe\nX-V: {{{{v}}}}\n");

    let session = Arc::new(Session::default());
    let ctx = context(Some(root.path()), &session);
    let file: PathBuf = root.path().join("test.http");
    session.prompt_answers().answer(&format!("{}#1", file.display()), HashMap::from([("v".into(), "prompt".into())]));
    send_one(&ctx, &file, &text, 0).await.unwrap();
    send_one(&ctx, &file, &text, 1).await.unwrap();
    let got = received(&server, "/probe").await.pop().unwrap();
    header(&got, "x-v").unwrap()
}

/// Every pair the research ran, with what `ijhttp` sent (Q6's table). A Prompt variable
/// has no effect in `ijhttp`; in HttpDesk an answered one wins over everything (GLOSSARY).
#[tokio::test]
async fn each_pair_of_places_sends_the_value_rider_sends() {
    let pairs = [
        ([Public, Private], "env-private"),
        ([Public, Global], "global"),
        ([Private, Global], "global"),
        ([Public, InPlace], "in-place"),
        ([Private, InPlace], "in-place"),
        ([Global, InPlace], "in-place"),
        ([Public, PreRequest], "per-request"),
        ([Private, PreRequest], "per-request"),
        ([Global, PreRequest], "per-request"),
        ([InPlace, PreRequest], "per-request"),
        ([Public, Prompt], "prompt"),
        ([Private, Prompt], "prompt"),
        ([Global, Prompt], "prompt"),
        ([InPlace, Prompt], "prompt"),
        ([PreRequest, Prompt], "prompt"),
    ];
    for (places, expected) in pairs {
        assert_eq!(probe(&places).await, expected, "{places:?}");
    }
}

#[tokio::test]
async fn with_every_place_at_once_the_pre_request_script_wins_and_an_answered_prompt_over_it() {
    assert_eq!(probe(&[Public, Private, Global, InPlace, PreRequest]).await, "per-request");
    assert_eq!(probe(&[Public, Private, Global, InPlace, PreRequest, Prompt]).await, "prompt");
}

#[tokio::test]
async fn a_requests_own_declaration_still_beats_one_at_the_top_of_the_file_and_both_beat_a_global() {
    // JetBrains ignores a name declared twice with `@` (Q6); HttpDesk keeps its File variable rule.
    let server = server().await;
    let session = Arc::new(Session::default());
    session.globals().set("v", "global");
    let text =
        format!("@v = file-top\n\n### probe\n@v = in-request\nGET {uri}/probe\nX-V: {{{{v}}}}\n", uri = server.uri());

    send_one(&context(None, &session), Path::new("/ws/a.http"), &text, 0).await.unwrap();

    let got = received(&server, "/probe").await.pop().unwrap();
    assert_eq!(header(&got, "x-v").as_deref(), Some("in-request"));
}

#[tokio::test]
async fn a_global_variable_replacing_a_secret_is_not_masked_as_one_in_the_preview() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(env::PRIVATE_ENV_FILE), r#"{"dev": {"token": "s3cret"}}"#).unwrap();
    let session = Session::default();
    session.globals().set("token", "from-login");
    let out = Outgoing::all_in(&root.path().join("a.http"), &parse("GET https://example.com/?t={{token}}\n")).remove(0);

    let scope = send::scope(Some(root.path()), Some("dev"), &session, &out).unwrap();
    let preview = exec::preview(&out.request, scope.resolver);

    assert_eq!(preview.url, "https://example.com/?t=from-login");
}
