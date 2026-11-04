//! Execution tests against a local mock server. The key property: disabled
//! components are never sent.

use std::collections::HashMap;
use std::path::Path;

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
    Mock::given(path("/echo")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true}))).mount(&server).await;
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
    req.auth = Auth { kind: AuthKind::ApiKey, key_name: "api_key".into(), key_value: "{{key}}".into(), key_location: ApiKeyLocation::Query, ..Default::default() };
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
        ("Content-Type: application/json\n\n< ./payload.json", br#"{"from":"file","v":"{{v}}"}"#.to_vec()),
        ("Content-Type: application/json\n\n<@ ./payload.json", br#"{"from":"file","v":"42"}"#.to_vec()),
    ];
    for (rest, expected) in cases {
        let req = parse(&format!("POST {{{{base}}}}/echo\n{rest}\n")).requests.remove(0);
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
async fn redirects_timeouts_and_methods() {
    let server = MockServer::start().await;
    Mock::given(path("/old")).respond_with(ResponseTemplate::new(302).insert_header("location", "/new")).mount(&server).await;
    Mock::given(path("/new")).respond_with(ResponseTemplate::new(200).set_body_string("new")).mount(&server).await;
    Mock::given(path("/slow")).respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(3))).mount(&server).await;
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
    assert!(matches!(err, ExecError::Timeout(_)), "{err}");

    let purge = parse("PURGE {{base}}/cache\n").requests.remove(0);
    assert_eq!(send(&purge, vars, Path::new(".")).await.unwrap().status, 204);
}

#[tokio::test]
async fn binary_responses_are_base64_and_text_is_decoded() {
    let server = MockServer::start().await;
    Mock::given(path("/img")).respond_with(ResponseTemplate::new(200).set_body_raw(vec![0x89, b'P', b'N', b'G', 0, 1], "image/png")).mount(&server).await;
    Mock::given(path("/latin1"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(vec![b'c', b'a', b'f', 0xE9], "text/plain; charset=iso-8859-1"))
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
