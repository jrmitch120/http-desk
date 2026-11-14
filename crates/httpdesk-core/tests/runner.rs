//! Runs (`run::run`) against a mock server: every request of a file in order, the
//! Session carried from each to the next, which requests fail, Stop, and the run's
//! options (stop on first failure, a delay between requests). Observed as what the
//! server receives and the events the run reports.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use httpdesk_core::exec::{ClientPool, ExecSettings};
use httpdesk_core::run::{self, Cancel, RunEvent, RunOptions};
use httpdesk_core::send::{Outgoing, Scripts, SendContext};
use httpdesk_core::session::Session;
use httpdesk_core::*;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, Request as Received, ResponseTemplate};

fn context(session: &Arc<Session>) -> SendContext {
    SendContext {
        root: None,
        environment: None,
        settings: ExecSettings::default(),
        scripts: Scripts::Run,
        session: session.clone(),
        clients: ClientPool::default(),
    }
}

/// Runs every request of `text` (the file at `/ws/api.http`), returning what the run
/// reported for each request, by index.
async fn run_file(session: &Arc<Session>, text: &str) -> Vec<(usize, Reported)> {
    run_file_with(session, text, RunOptions::default()).await
}

/// Runs every request of `text` with `options` (see `run_file`).
async fn run_file_with(session: &Arc<Session>, text: &str, options: RunOptions) -> Vec<(usize, Reported)> {
    run_file_cancelling(session, text, options, &Cancel::default(), |_, _| {}).await
}

/// What a run reported for one request, without the response body.
#[derive(Debug, Clone, PartialEq)]
enum Reported {
    Sending,
    Sent { status: u16, failed: bool },
    Failed(String),
    Cancelled,
}

async fn run_file_cancelling(
    session: &Arc<Session>,
    text: &str,
    options: RunOptions,
    cancel: &Cancel,
    on_event: impl Fn(usize, &Reported) + Send,
) -> Vec<(usize, Reported)> {
    let file = parse(text);
    run_outgoing(session, Outgoing::all_in(Path::new("/ws/api.http"), &file), options, cancel, on_event).await
}

/// Runs every request of each `(path, text)` file, the files in the order given (as a
/// folder's run does), returning what the run reported.
async fn run_files(session: &Arc<Session>, files: &[(&str, &str)]) -> Vec<(usize, Reported)> {
    let items = files.iter().flat_map(|(at, text)| Outgoing::all_in(Path::new(at), &parse(text))).collect();
    run_outgoing(session, items, RunOptions::default(), &Cancel::default(), |_, _| {}).await
}

async fn run_outgoing(
    session: &Arc<Session>,
    items: Vec<Outgoing>,
    options: RunOptions,
    cancel: &Cancel,
    on_event: impl Fn(usize, &Reported) + Send,
) -> Vec<(usize, Reported)> {
    let events = Mutex::new(Vec::new());
    run::run(&context(session), items, options, cancel, |i, event| {
        let reported = match event {
            RunEvent::Sending => Reported::Sending,
            RunEvent::Sent { sent, failed } => Reported::Sent { status: sent.response.status, failed },
            RunEvent::Failed(e) => Reported::Failed(e.to_string()),
            RunEvent::Cancelled => Reported::Cancelled,
        };
        on_event(i, &reported);
        events.lock().unwrap().push((i, reported));
    })
    .await;
    events.into_inner().unwrap()
}

async fn received(server: &MockServer, at: &str) -> Vec<Received> {
    server.received_requests().await.unwrap().into_iter().filter(|r| r.url.path() == at).collect()
}

fn header<'a>(r: &'a Received, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn a_login_then_a_call_with_its_token_runs_in_order_and_the_call_is_authorized() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "token": "abc123" })))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let text = format!(
        "# @name login\n\
         POST {uri}/login\n\
         \n\
         ###\n\
         GET {uri}/me\n\
         Authorization: Bearer {{{{login.response.body.$.token}}}}\n",
        uri = server.uri()
    );
    let session = Arc::new(Session::default());

    let events = run_file(&session, &text).await;

    assert_eq!(
        events,
        vec![
            (0, Reported::Sending),
            (0, Reported::Sent { status: 200, failed: false }),
            (1, Reported::Sending),
            (1, Reported::Sent { status: 200, failed: false }),
        ]
    );
    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "authorization"), Some("Bearer abc123"));
    assert!(session.exchanges().latest(Path::new("/ws/api.http"), "login").is_some(), "the run updates the Session");
}

#[tokio::test]
async fn a_run_sends_each_request_the_way_a_send_does_pre_request_script_included() {
    let server = MockServer::start().await;
    Mock::given(path("/signed/abc-42")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let text = format!(
        "< {{% request.variables.set(\"signature\", \"abc-\" + (40 + 2)) %}}\nGET {uri}/signed/{{{{signature}}}}\n",
        uri = server.uri()
    );

    let events = run_file(&Arc::new(Session::default()), &text).await;

    assert_eq!(events[1], (0, Reported::Sent { status: 200, failed: false }));
}

#[tokio::test]
async fn an_error_status_alone_is_not_a_failure_and_a_failing_test_or_blocked_send_is() {
    let server = MockServer::start().await;
    Mock::given(path("/missing")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
    Mock::given(path("/ok")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    // `nobody` is named in the file but never sent before its reader: that send is blocked.
    let text = format!(
        "GET {uri}/missing\n\
         \n\
         ###\n\
         GET {uri}/ok\n\
         \n\
         > {{%\n\
         client.test(\"Created\", function() {{ client.assert(response.status === 201, \"Expected 201\"); }});\n\
         %}}\n\
         \n\
         ###\n\
         GET {uri}/ok?token={{{{nobody.response.body.$.token}}}}\n\
         \n\
         ###\n\
         # @name nobody\n\
         GET {uri}/ok\n",
        uri = server.uri()
    );

    let events = run_file(&Arc::new(Session::default()), &text).await;

    let outcomes: Vec<&Reported> = events.iter().filter(|(_, r)| *r != Reported::Sending).map(|(_, r)| r).collect();
    assert_eq!(outcomes[0], &Reported::Sent { status: 404, failed: false }, "a 404 with no tests");
    assert_eq!(outcomes[1], &Reported::Sent { status: 200, failed: true }, "a failing client.test");
    assert!(matches!(outcomes[2], Reported::Failed(m) if m.contains("`nobody`")), "a blocked send: {:?}", outcomes[2]);
    assert_eq!(outcomes[3], &Reported::Sent { status: 200, failed: false }, "a failure doesn't stop the run");
    assert_eq!(outcomes.len(), 4);
}

#[tokio::test]
async fn stopping_a_run_cancels_the_request_in_flight_and_sends_nothing_after_it() {
    let server = MockServer::start().await;
    Mock::given(path("/one")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    Mock::given(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(30)))
        .mount(&server)
        .await;
    Mock::given(path("/three")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let text = format!("GET {uri}/one\n\n###\nGET {uri}/slow\n\n###\nGET {uri}/three\n", uri = server.uri());
    let cancel = Cancel::default();

    let stopper = cancel.clone();
    let stop_once_slow_is_sent = move |i: usize, r: &Reported| {
        if i == 1 && *r == Reported::Sending {
            let stopper = stopper.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                stopper.cancel();
            });
        }
    };
    let session = Arc::new(Session::default());
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        run_file_cancelling(&session, &text, RunOptions::default(), &cancel, stop_once_slow_is_sent),
    )
    .await
    .expect("the run stops without waiting for the slow response");

    assert_eq!(
        events,
        vec![
            (0, Reported::Sending),
            (0, Reported::Sent { status: 200, failed: false }),
            (1, Reported::Sending),
            (1, Reported::Cancelled),
        ]
    );
    assert!(received(&server, "/three").await.is_empty(), "nothing after the stopped request is sent");
}

#[tokio::test]
async fn stopping_a_run_during_its_delay_stops_it_at_once() {
    let server = MockServer::start().await;
    Mock::given(path("/one")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    Mock::given(path("/two")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let text = format!("GET {uri}/one\n\n###\nGET {uri}/two\n", uri = server.uri());
    let cancel = Cancel::default();

    let stopper = cancel.clone();
    let stop_once_one_is_sent = move |i: usize, r: &Reported| {
        if i == 0 && matches!(r, Reported::Sent { .. }) {
            let stopper = stopper.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                stopper.cancel();
            });
        }
    };
    let options = RunOptions { delay: Duration::from_secs(60), ..RunOptions::default() };
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        run_file_cancelling(&Arc::new(Session::default()), &text, options, &cancel, stop_once_one_is_sent),
    )
    .await
    .expect("the run stops without waiting out its delay");

    assert_eq!(events, vec![(0, Reported::Sending), (0, Reported::Sent { status: 200, failed: false })]);
    assert!(received(&server, "/two").await.is_empty(), "nothing after the delay is sent");
}

#[tokio::test]
async fn with_stop_on_first_failure_the_run_ends_after_the_first_failing_request() {
    let server = MockServer::start().await;
    Mock::given(path("/missing")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
    Mock::given(path("/ok")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    Mock::given(path("/after")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    // A 404 alone isn't a failure; the failing test is.
    let text = format!(
        "GET {uri}/missing\n\
         \n\
         ###\n\
         GET {uri}/ok\n\
         \n\
         > {{%\n\
         client.test(\"Created\", function() {{ client.assert(response.status === 201, \"Expected 201\"); }});\n\
         %}}\n\
         \n\
         ###\n\
         GET {uri}/after\n",
        uri = server.uri()
    );

    let options = RunOptions { stop_on_failure: true, ..RunOptions::default() };
    let events = run_file_with(&Arc::new(Session::default()), &text, options).await;

    assert_eq!(
        events,
        vec![
            (0, Reported::Sending),
            (0, Reported::Sent { status: 404, failed: false }),
            (1, Reported::Sending),
            (1, Reported::Sent { status: 200, failed: true }),
        ]
    );
    assert!(received(&server, "/after").await.is_empty(), "nothing after the failing request is sent");
}

#[tokio::test]
async fn with_stop_on_first_failure_a_blocked_send_ends_the_run_too() {
    let server = MockServer::start().await;
    Mock::given(path("/ok")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    // `nobody` is read before it's sent: that send is blocked.
    let text = format!(
        "GET {uri}/ok?token={{{{nobody.response.body.$.token}}}}\n\
         \n\
         ###\n\
         # @name nobody\n\
         GET {uri}/ok\n",
        uri = server.uri()
    );

    let options = RunOptions { stop_on_failure: true, ..RunOptions::default() };
    let events = run_file_with(&Arc::new(Session::default()), &text, options).await;

    assert_eq!(events.len(), 2, "{events:?}");
    assert!(matches!(&events[1], (0, Reported::Failed(_))), "{events:?}");
    assert!(received(&server, "/ok").await.is_empty(), "nothing after the blocked request is sent");
}

#[tokio::test]
async fn a_cookie_set_in_one_file_is_sent_by_the_next_file_of_the_run() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).insert_header("set-cookie", "sid=abc123; Path=/"))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let auth = format!("POST {uri}/login\n", uri = server.uri());
    let users = format!("GET {uri}/me\n", uri = server.uri());

    run_files(&Arc::new(Session::default()), &[("/ws/auth.http", &auth), ("/ws/users.http", &users)]).await;

    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "cookie"), Some("sid=abc123"));
}

#[tokio::test]
async fn a_global_variable_set_in_one_file_is_read_by_the_next_file_of_the_run() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "token": "abc123" })))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let auth = format!(
        "POST {uri}/login\n\n> {{% client.global.set(\"token\", response.body.token) %}}\n",
        uri = server.uri()
    );
    let users = format!("GET {uri}/me\nAuthorization: Bearer {{{{token}}}}\n", uri = server.uri());

    let events =
        run_files(&Arc::new(Session::default()), &[("/ws/auth.http", &auth), ("/ws/users.http", &users)]).await;

    assert_eq!(events[3], (1, Reported::Sent { status: 200, failed: false }));
    let me = received(&server, "/me").await.pop().unwrap();
    assert_eq!(header(&me, "authorization"), Some("Bearer abc123"));
}

#[tokio::test]
async fn a_request_variable_doesnt_reach_another_file_even_with_the_same_name_earlier_in_the_run() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "token": "abc123" })))
        .mount(&server)
        .await;
    Mock::given(path("/me")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let auth = format!("# @name login\nPOST {uri}/login\n", uri = server.uri());
    // users.http names a `login` of its own, which the run hasn't sent when its reader goes.
    let users = format!(
        "GET {uri}/me\n\
         Authorization: Bearer {{{{login.response.body.$.token}}}}\n\
         \n\
         ###\n\
         # @name login\n\
         POST {uri}/login\n",
        uri = server.uri()
    );

    let events =
        run_files(&Arc::new(Session::default()), &[("/ws/auth.http", &auth), ("/ws/users.http", &users)]).await;

    assert!(
        matches!(&events[3], (1, Reported::Failed(m)) if m.contains("`login`")),
        "blocked as unsent: {:?}",
        events[3]
    );
    assert!(
        received(&server, "/me").await.is_empty(),
        "the second file's reader isn't sent with the first file's login"
    );
}
