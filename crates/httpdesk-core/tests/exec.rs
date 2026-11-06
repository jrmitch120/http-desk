//! Execution tests against a local mock server. The key property: disabled
//! components are never sent.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, execute_on, prepare, ExecClient, ExecError, ExecSettings};
use httpdesk_core::vars::Resolver;
use httpdesk_core::*;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request as Received, ResponseTemplate};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

async fn send(req: &Request, vars: HashMap<String, String>, base_dir: &Path) -> Result<exec::HttpResponse, ExecError> {
    let resolver = Resolver::new(vars);
    let settings = ExecSettings::default();
    let prepared = prepare(req, &resolver, base_dir, &settings)?;
    execute(prepared, &settings, &SslConfig::default()).await.map(|o| o.response)
}

async fn last_request(server: &MockServer) -> Received {
    server.received_requests().await.unwrap().pop().expect("server received a request")
}

fn header<'a>(r: &'a Received, name: &str) -> Option<&'a str> {
    r.headers.get(name).and_then(|v| v.to_str().ok())
}

async fn echo_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/echo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn disabled_components_are_not_sent() {
    let server = echo_server().await;
    let text = format!(
        "### Toggles\n\
         POST {}/echo?keep=1\n\
         #~ &drop=1\n\
         #~ Authorization: Bearer secret\n\
         X-Keep: yes\n\
         #~ X-Drop: no\n\
         Content-Type: application/json\n\
         #~| {{\"disabled\": true}}\n",
        server.uri()
    );
    let req = parse(&text).requests.remove(0);
    assert!(!req.auth.enabled && !req.body.enabled);

    let resp = send(&req, HashMap::new(), Path::new(".")).await.unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body_text.as_deref(), Some(r#"{"ok":true}"#));

    let got = last_request(&server).await;
    assert_eq!(got.url.query(), Some("keep=1"));
    assert_eq!(header(&got, "x-keep"), Some("yes"));
    assert!(header(&got, "x-drop").is_none());
    assert!(header(&got, "authorization").is_none());
    assert!(got.body.is_empty());
}

#[tokio::test]
async fn disabled_sections_send_nothing_from_that_section() {
    let server = echo_server().await;
    let mut req = Request {
        method: "GET".into(),
        url: format!("{}/echo", server.uri()),
        query: KvSection { enabled: false, items: vec![KeyValue::new("a", "1")] },
        headers: KvSection { enabled: false, items: vec![KeyValue::new("X-A", "1")] },
        auth: Auth { kind: AuthKind::Bearer, token: "t".into(), ..Default::default() },
        ..Default::default()
    };
    send(&req, HashMap::new(), Path::new(".")).await.unwrap();
    let got = last_request(&server).await;
    assert_eq!(got.url.query(), None);
    assert!(header(&got, "x-a").is_none());
    assert_eq!(header(&got, "authorization"), Some("Bearer t"), "auth is independent of the headers section");

    req.query.enabled = true;
    req.headers.enabled = true;
    send(&req, HashMap::new(), Path::new(".")).await.unwrap();
    let got = last_request(&server).await;
    assert_eq!(got.url.query(), Some("a=1"));
    assert_eq!(header(&got, "x-a"), Some("1"));
}

#[tokio::test]
async fn variables_and_auth_kinds() {
    let server = echo_server().await;
    let text = "@path = echo\n\
                ### basic\n\
                GET {{baseUrl}}/{{path}}?id={{id}}\n\
                Authorization: Basic {{user}} {{pass}}\n\
                X-Req: {{$uuid}}\n";
    let file = parse(text);
    let req = &file.requests[0];
    let mut vars = env(&[("baseUrl", &server.uri()), ("id", "7"), ("user", "alice"), ("pass", "pw")]);
    for v in &file.header.variables {
        vars.insert(v.name.clone(), v.value.clone());
    }
    let resp = send(req, vars.clone(), Path::new(".")).await.unwrap();
    assert!(resp.warnings.is_empty(), "{:?}", resp.warnings);
    let got = last_request(&server).await;
    assert_eq!(got.url.query(), Some("id=7"));
    assert_eq!(header(&got, "authorization"), Some("Basic YWxpY2U6cHc="));
    assert_eq!(header(&got, "x-req").unwrap().len(), 36);

    // API key in query
    let mut req = req.clone();
    req.auth = Auth {
        kind: AuthKind::ApiKey,
        key_name: "api_key".into(),
        key_value: "{{key}}".into(),
        key_location: ApiKeyLocation::Query,
        ..Default::default()
    };
    vars.insert("key".into(), "k1".into());
    send(&req, vars.clone(), Path::new(".")).await.unwrap();
    assert_eq!(last_request(&server).await.url.query(), Some("id=7&api_key=k1"));

    // Unresolved variables produce a warning rather than silently disappearing.
    vars.remove("id");
    let resp = send(&req, vars, Path::new(".")).await.unwrap();
    assert_eq!(resp.warnings, vec!["Unresolved variables: id"]);
}

#[tokio::test]
async fn bodies_json_form_multipart_and_files() {
    let server = echo_server().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("payload.json"), r#"{"from":"file","v":"{{v}}"}"#).unwrap();
    std::fs::write(dir.path().join("pic.bin"), [0u8, 159, 146, 150]).unwrap();
    let vars = env(&[("base", &server.uri()), ("v", "42")]);

    let cases = [
        ("Content-Type: application/json\n\n{\"a\": {{v}}}", b"{\"a\": 42}".to_vec()),
        ("Content-Type: application/x-www-form-urlencoded\n\nname=foo\n&v={{v}}", b"name=foo&v=42".to_vec()),
        (
            "Content-Type: application/x-www-form-urlencoded\n\nname=foo\nv={{v}}\nlast=1",
            b"name=foo&v=42&last=1".to_vec(),
        ),
        ("Content-Type: application/x-www-form-urlencoded\n\nname=foo&\nv={{v}}", b"name=foo&v=42".to_vec()),
        ("Content-Type: application/json\n\n< ./payload.json", br#"{"from":"file","v":"{{v}}"}"#.to_vec()),
        ("Content-Type: application/json\n\n<@ ./payload.json", br#"{"from":"file","v":"42"}"#.to_vec()),
        // No space after the marker: the editor shows it as a file body, so it is sent as one.
        ("Content-Type: application/json\n\n<./payload.json", br#"{"from":"file","v":"{{v}}"}"#.to_vec()),
        ("Content-Type: application/json\n\n<@./payload.json", br#"{"from":"file","v":"42"}"#.to_vec()),
        ("Content-Type: application/xml\n\n<tag/>", b"<tag/>".to_vec()),
    ];
    for (rest, expected) in cases {
        let req = parse(&format!("POST {{{{base}}}}/echo\n{rest}\n")).requests.remove(0);
        let is_file = rest.contains("payload.json");
        assert_eq!(req.body.mode == BodyMode::File, is_file, "editor body mode for {rest}");
        send(&req, vars.clone(), dir.path()).await.unwrap();
        assert_eq!(last_request(&server).await.body, expected, "{rest}");
    }

    let multipart = "POST {{base}}/echo\n\
        Content-Type: multipart/form-data; boundary=B\n\n\
        --B\n\
        Content-Disposition: form-data; name=\"field\"\n\n\
        {{v}}\n\
        --B\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"pic.bin\"\n\
        Content-Type: application/octet-stream\n\n\
        < ./pic.bin\n\
        --B--\n";
    let req = parse(multipart).requests.remove(0);
    assert_eq!(req.body.mode, BodyMode::Multipart);
    send(&req, vars.clone(), dir.path()).await.unwrap();
    let got = last_request(&server).await;
    let mut expected = b"--B\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\n42\r\n--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"pic.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
    expected.extend([0u8, 159, 146, 150]);
    expected.extend(b"\r\n--B--\r\n");
    assert_eq!(got.body, expected);

    let missing = parse("POST {{base}}/echo\n\n< ./nope.json\n").requests.remove(0);
    let err = send(&missing, vars, dir.path()).await.unwrap_err();
    assert!(matches!(err, ExecError::File { .. }), "{err}");
}

#[tokio::test]
async fn disabled_form_fields_are_not_sent() {
    let server = echo_server().await;
    let vars = env(&[("base", &server.uri())]);
    let form = "Content-Type: application/x-www-form-urlencoded\n\n";
    let cases = [
        // First, middle and last field disabled, one field per line.
        ("#~ a=1\nb=2\n&c=3", "b=2&c=3"),
        ("a=1\n#~ &b=2\n&c=3", "a=1&c=3"),
        ("a=1\n&b=2\n#~ &c=3", "a=1&b=2"),
        // A hand-edited file that kept the `&` on the first enabled field.
        ("#~ a=1\n&b=2", "b=2"),
        // Single-line layout: first, middle and last field disabled.
        ("#~ a=1\nb=2&c=3", "b=2&c=3"),
        ("a=1\n#~ &b=2\n&c=3&d=4", "a=1&c=3&d=4"),
        ("a=1&c=3\n#~ &b=2", "a=1&c=3"),
        // Plain comments are never sent, as in JetBrains and VS Code.
        ("a=1\n# note\n// note\n&c=3", "a=1&c=3"),
    ];
    for (body, expected) in cases {
        let req = parse(&format!("POST {{{{base}}}}/echo\n{form}{body}\n")).requests.remove(0);
        send(&req, vars.clone(), Path::new(".")).await.unwrap();
        assert_eq!(String::from_utf8(last_request(&server).await.body).unwrap(), expected, "{body}");
    }
}

#[tokio::test]
async fn disabled_multipart_parts_are_not_sent() {
    let server = echo_server().await;
    let vars = env(&[("base", &server.uri())]);
    let head = "POST {{base}}/echo\nContent-Type: multipart/form-data; boundary=B\n";
    let part = |name: &str, value: &str| format!("--B\nContent-Disposition: form-data; name=\"{name}\"\n\n{value}\n");
    let off = |text: String| text.lines().map(|l| format!("#~ {l}").trim_end().to_string() + "\n").collect::<String>();
    let expected = "--B\r\nContent-Disposition: form-data; name=\"b\"\r\n\r\n2\r\n--B--\r\n";

    let disabled_file = "--B\nContent-Disposition: form-data; name=\"f\"; filename=\"x.bin\"\n\
        Content-Type: application/octet-stream\n\n< ./missing.bin\n";
    let bodies = [
        // Written by HttpDesk: in the header area, with `#~=`.
        format!("{head}{}\n{}--B--\n", off(part("a", "1")).replace("#~", "#~="), part("b", "2")),
        // Held in memory (and hand-written) inline: first, last, and a file part.
        format!("{head}\n{}{}--B--\n", off(part("a", "1")), part("b", "2")),
        format!("{head}\n{}{}--B--\n", part("b", "2"), off(part("c", "3"))),
        format!("{head}\n{}{}{}--B--\n", off(part("a", "1")), part("b", "2"), off(part("c", "3"))),
        format!("{head}\n{}{}--B--\n", part("b", "2"), off(disabled_file.to_string())),
    ];
    for text in bodies {
        let req = parse(&text).requests.remove(0);
        send(&req, vars.clone(), Path::new(".")).await.unwrap();
        assert_eq!(String::from_utf8(last_request(&server).await.body).unwrap(), expected, "{text}");
    }
}

#[tokio::test]
async fn redirects_timeouts_and_methods() {
    let server = MockServer::start().await;
    Mock::given(path("/old"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/new"))
        .mount(&server)
        .await;
    Mock::given(path("/new")).respond_with(ResponseTemplate::new(200).set_body_string("new")).mount(&server).await;
    Mock::given(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(3)))
        .mount(&server)
        .await;
    Mock::given(method("PURGE")).respond_with(ResponseTemplate::new(204)).mount(&server).await;
    let vars = env(&[("base", &server.uri())]);

    let follow = parse("GET {{base}}/old\n").requests.remove(0);
    let resp = send(&follow, vars.clone(), Path::new(".")).await.unwrap();
    assert_eq!((resp.status, resp.body_text.as_deref()), (200, Some("new")));
    assert!(resp.url.ends_with("/new"));

    let no_follow = parse("# @no-redirect\nGET {{base}}/old\n").requests.remove(0);
    let resp = send(&no_follow, vars.clone(), Path::new(".")).await.unwrap();
    assert_eq!(resp.status, 302);
    assert_eq!(resp.status_text, "Found");

    let slow = parse("# @timeout 200 ms\nGET {{base}}/slow\n").requests.remove(0);
    let err = send(&slow, vars.clone(), Path::new(".")).await.unwrap_err();
    assert!(matches!(err, ExecError::ReadTimeout(_)), "{err}");

    let purge = parse("PURGE {{base}}/cache\n").requests.remove(0);
    assert_eq!(send(&purge, vars, Path::new(".")).await.unwrap().status, 204);
}

/// A one-shot HTTP server that writes `parts` with `gap` between them, for
/// timings wiremock can't express (a body that trickles in or stalls).
fn trickle_server(parts: Vec<Vec<u8>>, gap: Duration) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (mut head, mut buf) = (Vec::new(), [0u8; 4096]);
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => head.extend_from_slice(&buf[..n]),
            }
        }
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                std::thread::sleep(gap);
            }
            if stream.write_all(part).and_then(|_| stream.flush()).is_err() {
                return;
            }
        }
    });
    format!("http://{addr}")
}

fn response_head(content_length: usize) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

#[test]
fn timeout_directives_accept_jetbrains_units() {
    let r = Resolver::new(HashMap::new());
    let s = ExecSettings::default();
    let prepared = |text: &str| prepare(&parse(text).requests.remove(0), &r, Path::new("."), &s).unwrap();

    let p = prepared("# @connection-timeout 2 m\n# @timeout 100 ms\nGET https://x\n");
    assert_eq!((p.connect_timeout_ms, p.timeout_ms), (120_000, 100));

    let p = prepared("# @timeout 45\n# @connection-timeout 3\nGET https://x\n");
    assert_eq!((p.connect_timeout_ms, p.timeout_ms), (3_000, 45_000), "bare numbers are seconds");

    let p = prepared("# @timeout 2m\n# @connection-timeout 500ms\nGET https://x\n");
    assert_eq!((p.connect_timeout_ms, p.timeout_ms), (500, 120_000), "suffix without a space");

    let p = prepared("GET https://x\n");
    assert_eq!((p.connect_timeout_ms, p.timeout_ms), (s.connect_timeout_ms, s.timeout_ms), "app defaults");
}

#[tokio::test]
async fn a_body_that_keeps_streaming_outlives_the_idle_timeout() {
    // 8 one-byte chunks 100 ms apart: ~700 ms in total, never idle for 400 ms.
    let mut parts = vec![response_head(8)];
    parts.extend(b"abcdefgh".iter().map(|b| vec![*b]));
    let base = trickle_server(parts, Duration::from_millis(100));
    let req = parse(&format!("# @timeout 400 ms\nGET {base}/download\n")).requests.remove(0);

    let resp = send(&req, HashMap::new(), Path::new(".")).await.unwrap();
    assert_eq!(resp.body_text.as_deref(), Some("abcdefgh"));
    assert!(resp.time_ms > 400.0, "took {} ms", resp.time_ms);
}

#[tokio::test]
async fn a_body_that_stalls_fails_with_a_read_timeout_naming_the_value() {
    let mut first = response_head(8);
    first.extend(b"abcd");
    let base = trickle_server(vec![first, b"efgh".to_vec()], Duration::from_secs(3));
    let req = parse(&format!("# @timeout 200 ms\nGET {base}/download\n")).requests.remove(0);

    let err = send(&req, HashMap::new(), Path::new(".")).await.unwrap_err();
    assert!(matches!(err, ExecError::ReadTimeout(200)), "{err:?}");
    let msg = err.to_string();
    assert!(msg.contains("Read timeout") && msg.contains("200 ms") && msg.contains("@timeout"), "{msg}");
}

#[tokio::test]
async fn a_slow_connection_reports_a_connection_timeout_naming_the_value() {
    // Accepts TCP but never answers the TLS handshake, so connecting never finishes.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = silent.local_addr().unwrap();
    let req = parse(&format!("# @connection-timeout 300 ms\n# @timeout 10\nGET https://{addr}/\n")).requests.remove(0);

    let err = send(&req, HashMap::new(), Path::new(".")).await.unwrap_err();
    assert!(matches!(err, ExecError::ConnectTimeout(300)), "{err:?}");
    let msg = err.to_string();
    assert!(
        msg.contains("Connection timeout") && msg.contains("300 ms") && msg.contains("@connection-timeout"),
        "{msg}"
    );

    let req = parse(&format!("# @connection-timeout 1\n# @timeout 10\nGET https://{addr}/\n")).requests.remove(0);
    let msg = send(&req, HashMap::new(), Path::new(".")).await.unwrap_err().to_string();
    assert!(msg.contains("1 s"), "whole seconds are shown in seconds: {msg}");
    drop(silent);
}

#[tokio::test]
async fn binary_responses_are_base64_and_text_is_decoded() {
    let server = MockServer::start().await;
    Mock::given(path("/img"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(vec![0x89, b'P', b'N', b'G', 0, 1], "image/png"))
        .mount(&server)
        .await;
    Mock::given(path("/latin1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(vec![b'c', b'a', b'f', 0xE9], "text/plain; charset=iso-8859-1"),
        )
        .mount(&server)
        .await;
    let vars = env(&[("base", &server.uri())]);

    let resp = send(&parse("GET {{base}}/img\n").requests[0], vars.clone(), Path::new(".")).await.unwrap();
    assert!(resp.body_text.is_none());
    assert_eq!(resp.body_base64.as_deref(), Some("iVBORwAB"));
    assert_eq!(resp.body_size, 6);

    let resp = send(&parse("GET {{base}}/latin1\n").requests[0], vars, Path::new(".")).await.unwrap();
    assert_eq!(resp.body_text.as_deref(), Some("café"));
}

#[test]
fn prepare_rules() {
    let r = Resolver::new(HashMap::new());
    let s = ExecSettings::default();
    let req = parse("example.com/a\nHost: ignored\n").requests.remove(0);
    assert_eq!(prepare(&req, &r, Path::new("."), &s).unwrap().url, "http://example.com/a");

    let req = parse("GET example.com/login?next=http://foo\n").requests.remove(0);
    assert_eq!(
        prepare(&req, &r, Path::new("."), &s).unwrap().url,
        "http://example.com/login?next=http://foo",
        "scheme is looked for before `?` only"
    );

    let req = parse("GET /path\nHost: api.local:8080\n").requests.remove(0);
    assert_eq!(prepare(&req, &r, Path::new("."), &s).unwrap().url, "http://api.local:8080/path");

    let req = parse("POST https://x\n\n{\"a\":1}\n").requests.remove(0);
    let p = prepare(&req, &r, Path::new("."), &s).unwrap();
    assert_eq!(p.header("content-type"), Some("application/json"), "inferred from body mode");
    assert!(p.header("user-agent").unwrap().starts_with("HttpDesk/"));

    let req = parse("GET https://x\nUser-Agent: mine\n").requests.remove(0);
    assert_eq!(prepare(&req, &r, Path::new("."), &s).unwrap().header("user-agent"), Some("mine"));

    let req = parse("GET http://[bad\n").requests.remove(0);
    assert!(matches!(prepare(&req, &r, Path::new("."), &s), Err(ExecError::InvalidUrl { .. })));
}

#[test]
fn dynamic_variable_errors_stop_the_send() {
    let s = ExecSettings::default();
    let req = parse("POST https://x/a?n={{$randomInt 10 5}}\nX-Ts: {{$timestamp 1 fortnight}}\n").requests.remove(0);
    let err = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &s).unwrap_err();
    let msg = err.to_string();
    assert!(matches!(err, ExecError::DynamicVariable(_)), "{msg}");
    assert!(msg.contains("{{$randomInt 10 5}}") && msg.contains("fortnight"), "every failure is reported: {msg}");
}

#[test]
fn unresolved_host_names_the_variables_and_suggests_an_environment() {
    let s = ExecSettings::default();
    let req = parse("GET {{baseUrl}}/users?id={{id}}\n").requests.remove(0);
    let err = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &s).unwrap_err();
    let msg = err.to_string();
    assert!(
        matches!(&err, ExecError::UnresolvedHost(vars) if vars == &["baseUrl"]),
        "only host variables are named: {msg}"
    );
    assert!(msg.contains("baseUrl") && msg.contains("environment"), "{msg}");

    // A variable that resolves to a URL whose own host is unresolved names that inner variable.
    let r = Resolver::new(env(&[("baseUrl", "https://{{host}}:{{port}}/api")]));
    let msg = prepare(&req, &r, Path::new("."), &s).unwrap_err().to_string();
    assert!(msg.contains("host, port") && !msg.contains("baseUrl"), "{msg}");

    // A relative URL whose Host header is unresolved.
    let req = parse("GET /users\nHost: {{apiHost}}\n").requests.remove(0);
    let msg = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &s).unwrap_err().to_string();
    assert!(msg.contains("apiHost"), "{msg}");

    // An unresolved scheme gets the same error, not "relative URL without a base".
    let req = parse("GET {{scheme}}://api/x?id={{id}}\n").requests.remove(0);
    let err = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &s).unwrap_err();
    let msg = err.to_string();
    assert!(matches!(&err, ExecError::UnresolvedHost(vars) if vars == &["scheme"]), "{msg}");
    assert!(msg.contains("environment"), "{msg}");
}

// ---------------------------------------------------------------- query encoding (ADR-0001)

/// Sends `text` (one request, URL relative to `{{base}}`) and returns the raw query the server saw.
async fn sent_query(text: &str, vars: &[(&str, &str)]) -> (Option<String>, Vec<(String, String)>) {
    let server = echo_server().await;
    let mut vars = env(vars);
    vars.insert("base".into(), server.uri());
    send(&parse(text).requests[0], vars, Path::new(".")).await.unwrap();
    let got = last_request(&server).await;
    (
        got.url.query().map(str::to_string),
        got.url.query_pairs().map(|(n, v)| (n.into_owned(), v.into_owned())).collect(),
    )
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
}

#[tokio::test]
async fn variable_values_in_the_query_arrive_as_one_param() {
    let (_, got) = sent_query("GET {{base}}/echo?q={{q}}&n=1\n", &[("q", "a&b c#d")]).await;
    assert_eq!(got, pairs(&[("q", "a&b c#d"), ("n", "1")]));
}

#[tokio::test]
async fn an_empty_value_keeps_its_equals_sign_on_the_wire() {
    let (raw, _) = sent_query("GET {{base}}/echo?flag=&bare&v={{empty}}\n", &[("empty", "")]).await;
    assert_eq!(raw.as_deref(), Some("flag=&bare&v="));
}

#[tokio::test]
async fn existing_escapes_are_not_encoded_twice() {
    let (raw, got) = sent_query("GET {{base}}/echo?email=a%40b.c&q=a%20b%26c&t={{t}}\n", &[("t", "x%2Fy z")]).await;
    assert_eq!(raw.as_deref(), Some("email=a%40b.c&q=a%20b%26c&t=x%2Fy%20z"));
    assert_eq!(got, pairs(&[("email", "a@b.c"), ("q", "a b&c"), ("t", "x/y z")]));
}

#[tokio::test]
async fn the_rest_is_encoded_at_send() {
    let (raw, got) = sent_query("GET {{base}}/echo?ids[]=1|2&name=café&next=http://x/?a=1&sp=a+b\n", &[]).await;
    assert_eq!(
        raw.as_deref(),
        Some("ids%5B%5D=1%7C2&name=caf%C3%A9&next=http://x/?a=1&sp=a+b"),
        "a written `+` is kept"
    );
    assert_eq!(got, pairs(&[("ids[]", "1|2"), ("name", "café"), ("next", "http://x/?a=1"), ("sp", "a b")]));
}

#[tokio::test]
async fn no_auto_encoding_sends_the_query_as_written() {
    let (raw, _) =
        sent_query("# @no-auto-encoding\nGET {{base}}/echo?ids[]=1|2&q=a%2Bb&t={{t}}\n", &[("t", "x,y|z")]).await;
    assert_eq!(raw.as_deref(), Some("ids[]=1|2&q=a%2Bb&t=x,y|z"));
}

#[tokio::test]
async fn an_api_key_query_param_is_resolved_and_encoded() {
    let text = "# @httpdesk-auth apikey query {{keyName}}\nGET {{base}}/echo?n=1&{{keyName}}={{key}}\n";
    let (_, got) = sent_query(text, &[("keyName", "api key"), ("key", "s3cr&t=/+")]).await;
    assert_eq!(got, pairs(&[("n", "1"), ("api key", "s3cr&t=/+")]));
}

// Timing. wiremock listens on 127.0.0.1; asking for `localhost` instead makes
// the request look the host up, so the DNS phase is measured.
fn by_name(server: &MockServer) -> String {
    server.uri().replace("127.0.0.1", "localhost")
}

#[tokio::test]
async fn a_fresh_request_times_each_phase_within_the_total() {
    let server = MockServer::start().await;
    Mock::given(path("/t"))
        .respond_with(
            ResponseTemplate::new(200).set_delay(Duration::from_millis(40)).set_body_string("x".repeat(200_000)),
        )
        .mount(&server)
        .await;
    let req = parse("GET {{base}}/t\n").requests.remove(0);
    let resp = send(&req, env(&[("base", &by_name(&server))]), Path::new(".")).await.unwrap();

    let t = &resp.timings;
    let dns = t.dns.expect("a lookup of localhost is timed");
    let connect = t.connect.expect("a new connection is timed");
    assert!(!t.reused);
    assert_eq!(t.redirects, 0);
    assert!(dns >= 0.0 && connect > 0.0 && t.download >= 0.0, "{t:?}");
    assert!(t.ttfb >= 40.0, "waiting covers the server's delay: {t:?}");
    assert!(dns + connect + t.ttfb + t.download <= resp.time_ms, "{t:?} within {}", resp.time_ms);
}

#[tokio::test]
async fn a_second_request_on_the_same_client_reuses_the_connection_and_skips_dns_and_connect() {
    let server = echo_server().await;
    let settings = ExecSettings::default();
    let resolver = Resolver::new(env(&[("base", &by_name(&server))]));
    let req = parse("GET {{base}}/echo\n").requests.remove(0);
    let prepared = || prepare(&req, &resolver, Path::new("."), &settings).unwrap();
    let client = ExecClient::new(&prepared(), &settings, &SslConfig::default()).unwrap();

    let first = execute_on(&client, prepared(), &settings).await.unwrap().response.timings;
    assert!(!first.reused && first.dns.is_some() && first.connect.is_some(), "{first:?}");

    let second = execute_on(&client, prepared(), &settings).await.unwrap().response.timings;
    assert!(second.reused, "{second:?}");
    assert_eq!((second.dns, second.connect), (None, None));
    assert!(second.ttfb > 0.0, "{second:?}");
}

#[tokio::test]
async fn a_redirect_chain_reports_its_length_and_times_the_final_hop() {
    let server = MockServer::start().await;
    for (from, to) in [("/a", "/b"), ("/b", "/c")] {
        Mock::given(path(from))
            .respond_with(ResponseTemplate::new(302).insert_header("location", to))
            .mount(&server)
            .await;
    }
    Mock::given(path("/c")).respond_with(ResponseTemplate::new(200).set_body_string("c")).mount(&server).await;
    let vars = env(&[("base", &by_name(&server))]);

    let resp = send(&parse("GET {{base}}/a\n").requests.remove(0), vars.clone(), Path::new(".")).await.unwrap();
    assert_eq!(resp.timings.redirects, 2);
    // The first hop opened the connection; the final one went over it.
    assert!(resp.timings.reused, "{:?}", resp.timings);
    assert_eq!((resp.timings.dns, resp.timings.connect), (None, None));

    let direct = send(&parse("GET {{base}}/c\n").requests.remove(0), vars.clone(), Path::new(".")).await.unwrap();
    assert_eq!(direct.timings.redirects, 0);
    let unfollowed = parse("# @no-redirect\nGET {{base}}/a\n").requests.remove(0);
    assert_eq!(send(&unfollowed, vars, Path::new(".")).await.unwrap().timings.redirects, 0);
}

#[tokio::test]
async fn a_redirect_to_another_server_times_the_final_hops_new_connection() {
    let target = MockServer::start().await;
    Mock::given(path("/end"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(40)))
        .mount(&target)
        .await;
    let origin = MockServer::start().await;
    Mock::given(path("/go"))
        .respond_with(
            ResponseTemplate::new(302)
                .set_delay(Duration::from_millis(60))
                .insert_header("location", format!("{}/end", by_name(&target)).as_str()),
        )
        .mount(&origin)
        .await;

    let req = parse("GET {{base}}/go\n").requests.remove(0);
    let resp = send(&req, env(&[("base", &by_name(&origin))]), Path::new(".")).await.unwrap();
    let t = &resp.timings;
    assert_eq!(t.redirects, 1);
    assert!(!t.reused && t.dns.is_some() && t.connect.is_some(), "{t:?}");
    assert!(t.ttfb >= 40.0 && t.ttfb < 100.0, "waiting is the final hop's, not the first: {t:?}");
    assert!(resp.time_ms >= 100.0, "the total covers both hops: {}", resp.time_ms);
}
