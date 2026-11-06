//! Execution tests against a local mock server. The key property: disabled
//! components are never sent.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, prepare, ExecError, ExecSettings};
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
    let r = report(&err);
    assert_eq!((&r["kind"], &r["details"]), (&"timeoutIdle".into(), &serde_json::json!({ "timeoutMs": 200 })));
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
    let r = report(&err);
    assert_eq!((&r["kind"], &r["details"]), (&"timeoutConnect".into(), &serde_json::json!({ "timeoutMs": 300 })));

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
    let r = report(&err);
    assert_eq!(
        (&r["kind"], &r["details"]),
        (&"unresolvedVariable".into(), &serde_json::json!({ "names": ["baseUrl"] }))
    );

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

// ---- Content encoding (#66) ----

/// A JSON body big and repetitive enough that every encoding shrinks it.
fn compressible_json() -> Vec<u8> {
    let items: Vec<_> = (0..200).map(|i| serde_json::json!({"id": i, "name": "a pet with a long name"})).collect();
    serde_json::to_vec(&items).unwrap()
}

/// Encodes `data` the way a server would for `Content-Encoding: <encoding>`.
fn encode(encoding: &str, data: &[u8]) -> Vec<u8> {
    match encoding {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        }
        // HTTP "deflate" is the zlib format (RFC 9110 sec. 8.4.1.2).
        "deflate" => {
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        }
        "br" => {
            let mut out = Vec::new();
            brotli::BrotliCompress(&mut &data[..], &mut out, &Default::default()).unwrap();
            out
        }
        "zstd" => zstd::encode_all(data, 0).unwrap(),
        other => panic!("no test encoder for {other}"),
    }
}

/// Serves `body` at `/data` as JSON with the given `Content-Encoding`.
async fn encoded_server(encoding: &str, body: Vec<u8>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/data"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Content-Encoding", encoding)
                .set_body_raw(body, "application/json"),
        )
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn an_encoded_response_reports_transferred_and_decoded_sizes_and_its_encoding() {
    let json = compressible_json();
    for encoding in ["gzip", "br", "deflate", "zstd"] {
        let wire = encode(encoding, &json);
        let server = encoded_server(encoding, wire.clone()).await;
        let vars = env(&[("base", &server.uri())]);

        let resp = send(&parse("GET {{base}}/data\n").requests[0], vars, Path::new(".")).await.unwrap();

        assert_eq!(resp.content_encoding.as_deref(), Some(encoding));
        assert_eq!(resp.transferred_size, wire.len(), "{encoding}: raw bytes on the wire");
        assert_eq!(resp.body_size, json.len(), "{encoding}: decoded size");
        assert!(resp.transferred_size < resp.body_size, "{encoding}");
        assert_eq!(resp.body_text.as_deref(), Some(std::str::from_utf8(&json).unwrap()), "{encoding}");
        assert!(resp.warnings.is_empty(), "{encoding}: {:?}", resp.warnings);
    }
}

#[tokio::test]
async fn accept_encoding_defaults_to_what_we_decode_and_a_set_one_is_sent_unchanged() {
    let server = echo_server().await;
    let vars = env(&[("base", &server.uri())]);

    let resp = send(&parse("GET {{base}}/echo\n").requests[0], vars.clone(), Path::new(".")).await.unwrap();
    let received = last_request(&server).await;
    assert_eq!(header(&received, "accept-encoding"), Some("gzip, deflate, br, zstd"));
    let shown = resp.request.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("accept-encoding"));
    assert_eq!(shown.map(|(_, v)| v.as_str()), Some("gzip, deflate, br, zstd"), "the Request tab lists it");

    send(&parse("GET {{base}}/echo\nAccept-Encoding: identity\n").requests[0], vars, Path::new(".")).await.unwrap();
    let received = last_request(&server).await;
    let sent: Vec<_> = received.headers.get_all("accept-encoding").iter().map(|v| v.to_str().unwrap()).collect();
    assert_eq!(sent, ["identity"]);
}

#[tokio::test]
async fn an_unsupported_encoding_shows_the_bytes_as_received_with_a_warning() {
    let wire = b"\x1f\x9d\x90some compressed bytes".to_vec();
    let server = encoded_server("compress", wire.clone()).await;
    let vars = env(&[("base", &server.uri())]);

    let resp = send(&parse("GET {{base}}/data\n").requests[0], vars, Path::new(".")).await.unwrap();

    assert_eq!(resp.content_encoding.as_deref(), Some("compress"));
    assert_eq!((resp.transferred_size, resp.body_size), (wire.len(), wire.len()));
    assert!(resp.body_text.is_none(), "still-encoded bytes are binary even though the type is JSON");
    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, resp.body_base64.unwrap()).unwrap();
    assert_eq!(raw, wire);
    assert_eq!(resp.warnings, ["Content-Encoding compress isn't supported; showing the bytes as received"]);
}

#[tokio::test]
async fn the_body_size_limit_applies_to_decoded_bytes() {
    let json = compressible_json();
    let wire = encode("gzip", &json);
    let server = encoded_server("gzip", wire.clone()).await;
    let settings = ExecSettings { max_body_bytes: wire.len() + 100, ..ExecSettings::default() };
    let req = parse(&format!("GET {}/data\n", server.uri())).requests.remove(0);
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();

    let out = execute(prepared, &settings, &SslConfig::default()).await.unwrap();

    assert!(out.response.truncated);
    assert_eq!(out.response.body_size, wire.len() + 100);
    assert_eq!(out.body, json[..wire.len() + 100]);
}

#[tokio::test]
async fn a_body_that_does_not_decode_fails_naming_the_encoding() {
    let mut wire = encode("gzip", &compressible_json());
    wire.truncate(wire.len() / 2);
    let server = encoded_server("gzip", wire).await;
    let vars = env(&[("base", &server.uri())]);

    let err = send(&parse("GET {{base}}/data\n").requests[0], vars, Path::new(".")).await.unwrap_err();

    assert!(matches!(err, ExecError::Other(_)), "{err}");
    assert_eq!(err.kind(), "other");
    assert!(err.to_string().contains("Could not decode the gzip response body"), "{err}");
}

// ---------------------------------------------------------------- classified send errors

/// What the UI receives for a failed send: `{ kind, message, details }`.
fn report(err: &ExecError) -> serde_json::Value {
    serde_json::to_value(err).unwrap()
}

#[tokio::test]
async fn a_closed_port_is_refused_with_host_and_port() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let req = parse(&format!("GET http://127.0.0.1:{port}/x\n")).requests.remove(0);

    let err = send(&req, HashMap::new(), Path::new(".")).await.unwrap_err();
    let r = report(&err);
    assert_eq!(r["kind"], "refused", "{r}");
    assert_eq!(r["details"], serde_json::json!({ "host": "127.0.0.1", "port": port }));
    assert!(r["message"].as_str().unwrap().contains("127.0.0.1"), "the error chain is kept: {r}");
}

#[tokio::test]
async fn an_unknown_host_is_a_dns_error_naming_the_host() {
    // `.invalid` is reserved (RFC 6761): it never resolves.
    let req = parse("GET http://api.exmaple.invalid/x\n").requests.remove(0);

    let r = report(&send(&req, HashMap::new(), Path::new(".")).await.unwrap_err());
    assert_eq!(r["kind"], "dns", "{r}");
    assert_eq!(r["details"], serde_json::json!({ "host": "api.exmaple.invalid" }));
}

#[tokio::test]
async fn a_server_that_hangs_up_without_answering_is_a_reset() {
    // Reads the request, then closes the connection with nothing written.
    let base = trickle_server(vec![], Duration::ZERO);
    let port = base.rsplit(':').next().unwrap().parse::<u16>().unwrap();
    let req = parse(&format!("GET {base}/x\n")).requests.remove(0);

    let r = report(&send(&req, HashMap::new(), Path::new(".")).await.unwrap_err());
    assert_eq!(r["kind"], "reset", "{r}");
    assert_eq!(r["details"], serde_json::json!({ "host": "127.0.0.1", "port": port }));
}

/// An HTTPS server on 127.0.0.1 presenting a self-signed certificate made by
/// `params`. Handshakes fail on the client side, so it never answers HTTP.
async fn tls_server(params: rcgen::CertificateParams) -> String {
    use std::sync::Arc;
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = params.self_signed(&key).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _ = acceptor.accept(stream).await;
            });
        }
    });
    format!("https://{addr}")
}

async fn tls_reason(params: rcgen::CertificateParams) -> serde_json::Value {
    let base = tls_server(params).await;
    let req = parse(&format!("GET {base}/x\n")).requests.remove(0);
    let r = report(&send(&req, HashMap::new(), Path::new(".")).await.unwrap_err());
    assert_eq!(r["kind"], "tls", "{r}");
    r["details"]["reason"].clone()
}

#[tokio::test]
async fn a_self_signed_certificate_is_a_tls_error_saying_so() {
    let params = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
    assert_eq!(tls_reason(params).await, "selfSigned");
}

#[tokio::test]
async fn an_expired_certificate_is_a_tls_error_saying_so() {
    let mut params = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
    params.not_before = rcgen::date_time_ymd(2020, 1, 1);
    params.not_after = rcgen::date_time_ymd(2021, 1, 1);
    assert_eq!(tls_reason(params).await, "expired");
}

#[tokio::test]
async fn cookies_set_on_a_redirect_hop_and_the_final_response_are_both_listed_and_never_sent_back() {
    let server = MockServer::start().await;
    Mock::given(path("/login"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "/home")
                .insert_header("set-cookie", "a=1; Path=/; HttpOnly"),
        )
        .mount(&server)
        .await;
    Mock::given(path("/home"))
        .respond_with(
            ResponseTemplate::new(200)
                .append_header("set-cookie", "b=2; Max-Age=60; SameSite=Lax")
                .append_header("set-cookie", "not a cookie"),
        )
        .mount(&server)
        .await;
    let req = parse("GET {{base}}/login\n").requests.remove(0);
    let resp = send(&req, env(&[("base", &server.uri())]), Path::new(".")).await.unwrap();
    assert_eq!(resp.status, 200);

    let got: Vec<_> = resp.cookies.iter().map(|c| (c.name.as_str(), c.value.as_str(), c.url.as_str())).collect();
    let (login, home) = (format!("{}/login", server.uri()), format!("{}/home", server.uri()));
    assert_eq!(got, [("a", "1", login.as_str()), ("b", "2", home.as_str()), ("", "", home.as_str())]);
    assert!(resp.cookies[0].http_only);
    assert_eq!((resp.cookies[1].max_age, resp.cookies[1].same_site.as_deref()), (Some(60), Some("Lax")));
    assert_eq!(resp.cookies[2].raw, "not a cookie");

    let hops = server.received_requests().await.unwrap();
    assert_eq!(hops.len(), 2);
    assert!(hops.iter().all(|r| r.headers.get("cookie").is_none()), "a cookie was sent back");
}

#[tokio::test]
async fn a_cookie_header_the_user_wrote_is_still_sent() {
    let server = echo_server().await;
    let req = parse("GET {{base}}/echo\nCookie: mine=1\n").requests.remove(0);
    let resp = send(&req, env(&[("base", &server.uri())]), Path::new(".")).await.unwrap();
    assert!(resp.cookies.is_empty());
    assert_eq!(header(&last_request(&server).await, "cookie"), Some("mine=1"));
}
