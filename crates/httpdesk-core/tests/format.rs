//! Parsing, serialization and component enablement round-trip tests.

use httpdesk_core::*;

const JETBRAINS: &str = include_str!("fixtures/jetbrains.http");
const VSCODE: &str = include_str!("fixtures/vscode.http");


/// Strips fields that only exist for lossless round-tripping.
fn semantic(mut r: Request) -> Request {
    r.raw = None;
    r.leading = String::new();
    r
}

// ---------------------------------------------------------------- parsing

#[test]
fn parses_jetbrains_fixture() {
    let f = parse(JETBRAINS);
    assert_eq!(f.header.variables.len(), 2);
    assert_eq!(f.header.variables[0], Variable { name: "host".into(), value: "https://httpbin.org".into() });

    let names: Vec<_> = f.requests.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(
        names,
        ["Get request with a header", "Post with JSON body", "Multi-line query", "Basic auth", "Send a form with the text and file fields"]
    );

    let get = &f.requests[0];
    assert_eq!(get.method, "GET");
    assert_eq!(get.url, "{{host}}/get");
    assert_eq!(get.query.items, vec![KeyValue::new("show_env", "1")]);
    assert_eq!(get.comments, vec!["A JetBrains-style comment describing the request"]);
    assert_eq!(get.headers.items, vec![KeyValue::new("Accept", "application/json")]);

    let post = &f.requests[1];
    assert_eq!(post.directive("no-redirect"), Some(""));
    assert_eq!(post.directive("timeout"), Some("30"));
    assert_eq!(post.auth.kind, AuthKind::Bearer);
    assert_eq!(post.auth.token, "{{token}}");
    assert!(post.header("authorization").is_none(), "auth header is lifted into the auth component");
    assert_eq!(post.body.mode, BodyMode::Json);
    assert!(post.body.text.starts_with("{\n  \"id\": 999"));
    assert!(post.body.text.ends_with('}'));
    assert!(post.response_handler.as_deref().unwrap().starts_with("> {%"));

    let multi = &f.requests[2];
    assert_eq!(multi.url, "https://example.com/comments");
    assert_eq!(multi.query.items, vec![KeyValue::new("page", "2"), KeyValue::new("pageSize", "10")]);

    let basic = &f.requests[3];
    assert_eq!((basic.auth.kind, basic.auth.username.as_str(), basic.auth.password.as_str()), (AuthKind::Basic, "user", "passwd"));

    // The comment-only block is kept as leading text of the next request.
    let form = &f.requests[4];
    assert!(form.leading.contains("Section divider with notes only"));
    assert_eq!(form.body.mode, BodyMode::Multipart);
    assert!(form.body.text.contains("< ./request-form-data.json"));
    assert_eq!(form.response_handler.as_deref(), Some(">> response.json"));
}

#[test]
fn parses_vscode_fixture() {
    let f = parse(VSCODE);
    assert_eq!(f.header.variables.len(), 0, "variables share the first block with a request");
    let login = &f.requests[0];
    assert_eq!(login.variables.len(), 2);
    assert_eq!(login.directive("name"), Some("login"));
    assert_eq!(login.http_version.as_deref(), Some("HTTP/1.1"));
    assert_eq!(login.url, "{{baseUrl}}/login");
    assert_eq!(login.display_name(), "login");

    let profile = &f.requests[1];
    assert_eq!(profile.directive("prompt"), Some("otp Your one-time password"));
    assert_eq!((profile.auth.kind, profile.auth.username.as_str(), profile.auth.password.as_str()), (AuthKind::Basic, "user", "passwd"));

    let form = &f.requests[2];
    assert_eq!(form.comments, vec!["Form URL encoded"]);
    assert_eq!(form.body.mode, BodyMode::FormUrlEncoded);
    assert_eq!(form.body.text, "name=foo\n&password=bar");

    let patch = &f.requests[3];
    assert_eq!(patch.method, "PATCH");
    assert_eq!(patch.body.mode, BodyMode::File);
}

#[test]
fn parses_url_only_and_custom_methods() {
    let f = parse("https://example.com/a\n\n###\nPURGE https://example.com/cache\n\n### lower\nget https://example.com/b\n");
    assert_eq!((f.requests[0].method.as_str(), f.requests[0].url.as_str()), ("GET", "https://example.com/a"));
    assert_eq!(f.requests[1].method, "PURGE");
    assert_eq!(f.requests[2].method, "GET");
    assert_eq!(f.requests[2].url, "https://example.com/b");
}

#[test]
fn pre_encoded_basic_auth_is_decoded() {
    let f = parse("GET https://x\nAuthorization: Basic dXNlcjpwYXNz\n");
    assert_eq!((f.requests[0].auth.username.as_str(), f.requests[0].auth.password.as_str()), ("user", "pass"));
}

#[test]
fn unknown_authorization_schemes_stay_headers() {
    let f = parse("GET https://x\nAuthorization: Digest abc\n");
    assert_eq!(f.requests[0].auth.kind, AuthKind::None);
    assert_eq!(f.requests[0].headers.items[0].name, "Authorization");

    // A single opaque token after Basic can't be split into user/password.
    let f = parse("GET https://x\nAuthorization: Basic {{encoded}}\n");
    assert_eq!(f.requests[0].auth.kind, AuthKind::None);
}

#[test]
fn plain_comments_are_not_treated_as_disabled_items() {
    let f = parse("GET https://x\n# Note: this is a comment\nAccept: */*\n");
    let r = &f.requests[0];
    assert_eq!(r.headers.items.len(), 1);
    assert_eq!(r.extra_lines, vec!["# Note: this is a comment"]);
}

// ---------------------------------------------------------------- lossless

#[test]
fn untouched_files_round_trip_byte_for_byte() {
    for src in [JETBRAINS, VSCODE] {
        assert_eq!(serialize(&parse(src)), src);
    }
    let crlf = JETBRAINS.replace('\n', "\r\n");
    assert_eq!(serialize(&parse(&crlf)), crlf);
    let no_final_newline = "GET https://x\n\n###\nGET https://y";
    assert_eq!(serialize(&parse(no_final_newline)), no_final_newline);
}

#[test]
fn editing_one_request_leaves_others_untouched() {
    let mut f = parse(JETBRAINS);
    f.requests[2].query.items[0].value = "3".into();
    let out = serialize(&f);

    // Untouched JetBrains handler script and multipart body survive exactly.
    assert!(out.contains("client.test(\"Request executed successfully\", function() {"));
    assert!(out.contains("### Multi-line query\nGET https://example.com/comments?page=3&pageSize=10\n"));
    let before = JETBRAINS.split("### Multi-line query").next().unwrap();
    assert!(out.starts_with(before));
    let after = &JETBRAINS[JETBRAINS.find("### Basic auth").unwrap()..];
    assert!(out.ends_with(after));
}

#[test]
fn every_fixture_request_is_semantically_stable_when_rerendered() {
    for src in [JETBRAINS, VSCODE] {
        let f = parse(src);
        for r in &f.requests {
            let rendered = render_request(r);
            let back = parse(&rendered).requests.remove(0);
            assert_eq!(semantic(back), semantic(Request { leading: String::new(), ..r.clone() }), "{rendered}");
        }
    }
}

// ---------------------------------------------------------------- enablement

fn sample() -> Request {
    Request {
        name: "Toggle me".into(),
        method: "POST".into(),
        url: "{{baseUrl}}/pets".into(),
        query: KvSection {
            enabled: true,
            items: vec![KeyValue::new("limit", "20"), KeyValue::disabled("status", "sold"), KeyValue::new("q", "")],
        },
        headers: KvSection {
            enabled: true,
            items: vec![
                KeyValue::new("Accept", "application/json"),
                KeyValue::disabled("X-Debug", "true"),
                KeyValue::new("Content-Type", "application/json"),
            ],
        },
        auth: Auth { kind: AuthKind::Bearer, token: "{{token}}".into(), ..Default::default() },
        body: Body { enabled: true, mode: BodyMode::Json, text: "{\n  \"name\": \"Rex\"\n}".into() },
        ..Default::default()
    }
}

fn round_trip(r: &Request) -> (String, Request) {
    let file = HttpFile { requests: vec![r.clone()], ..Default::default() };
    let text = serialize(&file);
    let back = parse(&text).requests.remove(0);
    (text, semantic(back))
}

#[test]
fn item_level_disabled_components_round_trip() {
    let r = sample();
    let (text, back) = round_trip(&r);
    assert_eq!(
        text,
        "### Toggle me\n\
         POST {{baseUrl}}/pets?limit=20&q\n\
         #~ &status=sold\n\
         Authorization: Bearer {{token}}\n\
         Accept: application/json\n\
         #~ X-Debug: true\n\
         Content-Type: application/json\n\
         \n\
         {\n  \"name\": \"Rex\"\n}\n"
    );
    // Disabled query params come back after the enabled ones (documented).
    let mut expected = r.clone();
    expected.query.items = vec![KeyValue::new("limit", "20"), KeyValue::new("q", ""), KeyValue::disabled("status", "sold")];
    assert_eq!(back, expected);
}

#[test]
fn disabled_auth_and_body_round_trip() {
    let mut r = sample();
    r.auth.enabled = false;
    r.body.enabled = false;
    let (text, back) = round_trip(&r);
    assert!(text.contains("\n#~ Authorization: Bearer {{token}}\n"));
    assert!(text.contains("#~| {\n#~|   \"name\": \"Rex\"\n#~| }\n"));
    assert!(!text.contains("\n\n{"), "disabled body must not appear in the body position");
    assert!(!back.auth.enabled && back.auth.kind == AuthKind::Bearer && back.auth.token == "{{token}}");
    assert!(!back.body.enabled);
    assert_eq!(back.body.text, r.body.text);
    assert_eq!(back.body.mode, BodyMode::Json);
}

#[test]
fn section_level_toggles_preserve_item_state() {
    let mut r = sample();
    r.headers.enabled = false;
    r.query.enabled = false;
    let (text, back) = round_trip(&r);
    assert!(text.contains("# @httpdesk-disabled query, headers\n"));
    assert!(text.contains("POST {{baseUrl}}/pets\n"), "no active params in the URL: {text}");
    assert!(text.contains("#~ &limit=20\n#~~ &status=sold\n#~ &q\n"));
    assert!(text.contains("#~ Accept: application/json\n#~~ X-Debug: true\n"));
    // Auth is its own component and stays active.
    assert!(text.contains("\nAuthorization: Bearer {{token}}\n"));
    assert!(!back.headers.enabled && !back.query.enabled);
    assert_eq!(back.headers.items, r.headers.items);
    assert_eq!(back.query.items, r.query.items);
}

#[test]
fn externally_uncommented_item_reenables_section() {
    let text = "# @httpdesk-disabled headers\nGET https://x\n#~ A: 1\n#~~ B: 2\nC: 3\n";
    let r = parse(text).requests.remove(0);
    assert!(r.headers.enabled);
    let states: Vec<_> = r.headers.items.iter().map(|h| (h.name.as_str(), h.enabled)).collect();
    assert_eq!(states, [("A", false), ("B", false), ("C", true)]);
}

#[test]
fn api_key_auth_round_trips_in_header_and_query() {
    let mut r = sample();
    r.auth = Auth {
        kind: AuthKind::ApiKey,
        key_name: "X-API-Key".into(),
        key_value: "{{apiKey}}".into(),
        key_location: ApiKeyLocation::Header,
        ..Default::default()
    };
    let (text, back) = round_trip(&r);
    assert!(text.contains("# @httpdesk-auth apikey header X-API-Key\n"));
    assert!(text.contains("\nX-API-Key: {{apiKey}}\n"));
    assert_eq!(back.auth, r.auth);
    assert_eq!(back.headers.items, r.headers.items);

    r.auth.key_location = ApiKeyLocation::Query;
    r.auth.key_name = "api_key".into();
    r.query.enabled = false;
    let (text, back) = round_trip(&r);
    assert!(text.contains("POST {{baseUrl}}/pets?api_key={{apiKey}}\n"), "{text}");
    assert_eq!(back.auth, r.auth);
    assert!(!back.query.enabled, "the auth param does not re-enable a disabled query section");

    r.auth.enabled = false;
    let (text, back) = round_trip(&r);
    assert!(text.contains("#~ &api_key={{apiKey}}\n"));
    assert_eq!(back.auth, r.auth);
}

#[test]
fn basic_auth_edge_cases_round_trip() {
    for (u, p) in [("user", "pass"), ("user", ""), ("", "secret"), ("", ""), ("{{user}}", "{{password}}")] {
        let mut r = sample();
        r.auth = Auth { kind: AuthKind::Basic, username: u.into(), password: p.into(), ..Default::default() };
        let (_, back) = round_trip(&r);
        assert_eq!((back.auth.username.as_str(), back.auth.password.as_str()), (u, p));
    }
}

#[test]
fn empty_section_toggle_persists() {
    let r = Request { url: "https://x".into(), headers: KvSection { enabled: false, items: vec![] }, ..Default::default() };
    let (_, back) = round_trip(&r);
    assert!(!back.headers.enabled);
}

#[test]
fn stale_disabled_body_next_to_active_body_is_preserved() {
    let text = "POST https://x\n#~| old body\n\nnew body\n";
    let f = parse(text);
    assert_eq!(f.requests[0].body.text, "new body");
    assert_eq!(f.requests[0].extra_lines, vec!["#~| old body"]);
    assert_eq!(serialize(&f), text);
}

#[test]
fn file_variables_added_to_header_stay_in_header() {
    let mut f = parse("GET https://x\n");
    f.header.variables.push(Variable { name: "a".into(), value: "1".into() });
    let out = serialize(&f);
    assert_eq!(out, "@a = 1\n\n###\nGET https://x\n");
    let back = parse(&out);
    assert_eq!(back.header.variables.len(), 1);
    assert_eq!(back.requests.len(), 1);
}

#[test]
fn added_and_removed_requests_serialize_cleanly() {
    let mut f = parse(JETBRAINS);
    f.requests.remove(2);
    f.requests.push(Request { name: "New".into(), url: "https://new".into(), ..Default::default() });
    let out = serialize(&f);
    assert!(!out.contains("Multi-line query"));
    assert!(out.ends_with(">> response.json\n\n### New\nGET https://new\n"), "{out}");
    let back = parse(&out);
    assert_eq!(back.requests.len(), 5);
}
