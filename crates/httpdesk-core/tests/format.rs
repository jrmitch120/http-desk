//! Parsing, serialization and component enablement round-trip tests.

use httpdesk_core::*;

const JETBRAINS: &str = include_str!("fixtures/jetbrains.http");
const VSCODE: &str = include_str!("fixtures/vscode.http");
const HANDLERS: &str = include_str!("fixtures/handlers.http");

/// Strips fields that only exist for lossless round-tripping.
fn semantic(mut r: Request) -> Request {
    r.raw = None;
    r.auth.raw = None;
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
        [
            "Get request with a header",
            "Post with JSON body",
            "Multi-line query",
            "Basic auth",
            "Send a form with the text and file fields",
            "Per-request variable from a pre-request script",
            "Signed with a pre-request script",
            "Pre-request script file",
        ]
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
    assert_eq!(
        (basic.auth.kind, basic.auth.username.as_str(), basic.auth.password.as_str()),
        (AuthKind::Basic, "user", "passwd")
    );

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
    assert_eq!(
        (profile.auth.kind, profile.auth.username.as_str(), profile.auth.password.as_str()),
        (AuthKind::Basic, "user", "passwd")
    );

    let form = &f.requests[2];
    assert_eq!(form.comments, vec!["Form URL encoded"]);
    assert_eq!(form.body.mode, BodyMode::FormUrlEncoded);
    assert_eq!(form.body.text, "name=foo\n&password=bar");

    let patch = &f.requests[3];
    assert_eq!(patch.method, "PATCH");
    assert_eq!(patch.body.mode, BodyMode::File);
}

#[test]
fn prompt_variables_are_read_from_hash_and_slash_comments_with_or_without_a_description() {
    let src = "# @prompt username\n// @prompt otp Your one-time password\n#@prompt  password   \n# @prompt otp again\nGET https://x/{{username}}\n";
    let f = parse(src);
    let prompts = f.requests[0].prompts();
    let names: Vec<_> = prompts.iter().map(|p| (p.name.as_str(), p.description.as_str(), p.masked())).collect();
    assert_eq!(
        names,
        [("username", "", false), ("otp", "Your one-time password", false), ("password", "", true)],
        "declared once each, in order; the first description wins"
    );
    assert_eq!(serialize(&f), src, "written back unchanged");

    let profile = &parse(VSCODE).requests[1];
    assert_eq!(profile.prompts().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["otp"]);
}

#[test]
fn only_password_like_prompt_names_are_masked() {
    let masked = |name: &str| Prompt { name: name.into(), description: String::new() }.masked();
    for name in ["password", "Password", "PASSWD", "pass", "PaSs"] {
        assert!(masked(name), "{name}");
    }
    for name in ["passphrase", "userPassword", "otp", "token"] {
        assert!(!masked(name), "{name}");
    }
}

#[test]
fn parses_url_only_and_custom_methods() {
    let f = parse(
        "https://example.com/a\n\n###\nPURGE https://example.com/cache\n\n### lower\nget https://example.com/b\n",
    );
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
fn authorization_header_is_kept_as_written_while_credentials_are_unchanged() {
    let mut f = parse("GET https://x\nAuthorization: Basic dXNlcjpwYXNz\nAccept: */*\n");
    f.requests[0].headers.items[0].value = "text/plain".into();
    assert_eq!(serialize(&f), "###\nGET https://x\nAuthorization: Basic dXNlcjpwYXNz\nAccept: text/plain\n");

    f.requests[0].auth.enabled = false;
    assert!(serialize(&f).contains("\n#~ Authorization: Basic dXNlcjpwYXNz\n"));

    f.requests[0].auth.enabled = true;
    f.requests[0].auth.password = "changed".into();
    assert!(serialize(&f).contains("\nAuthorization: Basic user changed\n"));
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
    assert_eq!(
        r.extra_lines,
        vec![ExtraLine { text: "# Note: this is a comment".into(), before: Some("Accept".into()) }]
    );
}

// ---------------------------------------------------------------- lossless

#[test]
fn untouched_files_round_trip_byte_for_byte() {
    for src in [JETBRAINS, VSCODE, HANDLERS] {
        assert_eq!(serialize(&parse(src)), src);
        let crlf = src.replace('\n', "\r\n");
        assert_eq!(serialize(&parse(&crlf)), crlf);
    }
    let no_final_newline = "GET https://x\n\n###\nGET https://y";
    assert_eq!(serialize(&parse(no_final_newline)), no_final_newline);
}

#[test]
fn response_handlers_parse_into_parts_and_the_file_is_unchanged() {
    let f = parse(HANDLERS);
    let parts: Vec<_> = f.requests.iter().map(Request::response_handler_parts).collect();
    let inline = |source: &str, line| HandlerPart::Inline { source: source.into(), line };
    assert_eq!(
        parts[0],
        [inline(r#" client.test("ok", () => client.assert(response.status === 200, "status")); "#, 1)]
    );
    let HandlerPart::Inline { source, line: 1 } = &parts[1][0] else { panic!("{:?}", parts[1]) };
    assert!(source.starts_with("\n    client.test(\"Request executed successfully\""), "{source}");
    assert!(source.ends_with("received '${type}'`);\n    });\n"), "{source}");
    assert_eq!(
        parts[2],
        [
            inline(r#" client.assert(response.body.length > 0, "not empty"); "#, 1),
            HandlerPart::Redirect { path: "./report.json".into(), overwrite: true },
        ]
    );
    assert_eq!(parts[3], [HandlerPart::File { path: "./check-status.js".into() }]);
    assert_eq!(parts[4], [HandlerPart::Redirect { path: "./saved.json".into(), overwrite: false }]);
    let runs: Vec<bool> = f.requests.iter().map(script::has_scripts).collect();
    assert_eq!(runs, [true, true, true, true, false]);
    assert_eq!(serialize(&f), HANDLERS);
}

#[test]
fn pre_request_scripts_parse_into_parts_and_the_file_is_unchanged() {
    let f = parse(JETBRAINS);
    let parts: Vec<_> = f.requests[5..].iter().map(Request::pre_request_parts).collect();
    assert_eq!(
        parts[0],
        [PreRequestPart::Inline { source: r#" request.variables.set("firstname", "John") "#.into(), line: 1 }]
    );
    let PreRequestPart::Inline { source, line: 1 } = &parts[1][0] else { panic!("{:?}", parts[1]) };
    assert!(source.starts_with("\nconst signature = crypto.hmac.sha256()\n"), "{source}");
    assert!(source.ends_with("request.variables.set(\"hash\", hash)\n"), "{source}");
    assert_eq!(parts[2], [PreRequestPart::File { path: "scripts/my-script.js".into() }]);
    assert!(f.requests[..5].iter().all(|r| r.pre_request_parts().is_empty()));

    let runs: Vec<bool> = f.requests.iter().map(script::has_scripts).collect();
    assert_eq!(runs, [false, true, false, false, false, true, true, true], "a pre-request script needs trust too");
    assert_eq!(serialize(&f), JETBRAINS);
}

#[test]
fn several_pre_request_blocks_each_count_lines_from_the_whole_script() {
    let req = parse("< {% a(); %}\n< {%\n  b();\n%}\n< ./c.js\nGET https://x\n").requests.remove(0);
    assert_eq!(
        req.pre_request_parts(),
        [
            PreRequestPart::Inline { source: " a(); ".into(), line: 1 },
            PreRequestPart::Inline { source: "\n  b();\n".into(), line: 2 },
            PreRequestPart::File { path: "./c.js".into() },
        ]
    );
}

#[test]
fn editing_a_request_with_a_handler_keeps_the_handler_verbatim() {
    let mut f = parse(HANDLERS);
    f.requests[1].url = "https://example.com/signin".into();
    let out = serialize(&f);
    assert_eq!(out, HANDLERS.replace("https://example.com/login", "https://example.com/signin"));
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
fn extracting_a_file_variable_rewrites_only_the_header_and_the_edited_request() {
    // Extract to variable: a new `@name` line at the top, `{{name}}` in one request's URL.
    let mut f = parse(JETBRAINS);
    f.header.variables.push(Variable { name: "exampleHost".into(), value: "https://example.com".into() });
    f.requests[2].url = "{{exampleHost}}/comments".into();
    let out = serialize(&f);

    assert!(out.starts_with(
        "@host = https://httpbin.org\n@userId = 42\n@exampleHost = https://example.com\n\n### Get request"
    ));
    assert!(out.contains("### Multi-line query\nGET {{exampleHost}}/comments?page=2&pageSize=10\n"));
    let untouched_before =
        &JETBRAINS[JETBRAINS.find("### Get request").unwrap()..JETBRAINS.find("### Multi-line query").unwrap()];
    assert!(out.contains(untouched_before));
    let untouched_after = &JETBRAINS[JETBRAINS.find("### Basic auth").unwrap()..];
    assert!(out.ends_with(untouched_after));
}

#[test]
fn every_fixture_request_is_semantically_stable_when_rerendered() {
    for src in [JETBRAINS, VSCODE, HANDLERS] {
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
    expected.query.items =
        vec![KeyValue::new("limit", "20"), KeyValue::new("q", ""), KeyValue::disabled("status", "sold")];
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
    for (u, p) in [
        ("user", "pass"),
        ("user", ""),
        ("", "secret"),
        ("", ""),
        ("{{user}}", "{{password}}"),
        ("John Doe", "pass"),
        ("John Doe", ""),
        ("user", "two words"),
        ("user", "pa:ss"),
        ("user", " padded "),
    ] {
        let mut r = sample();
        r.auth = Auth { kind: AuthKind::Basic, username: u.into(), password: p.into(), ..Default::default() };
        let (_, back) = round_trip(&r);
        assert_eq!((back.auth.username.as_str(), back.auth.password.as_str()), (u, p));
    }
}

#[test]
fn empty_section_toggle_persists() {
    let r =
        Request { url: "https://x".into(), headers: KvSection { enabled: false, items: vec![] }, ..Default::default() };
    let (_, back) = round_trip(&r);
    assert!(!back.headers.enabled);
}

#[test]
fn stale_disabled_body_next_to_active_body_is_preserved() {
    let text = "POST https://x\n#~| old body\n\nnew body\n";
    let f = parse(text);
    assert_eq!(f.requests[0].body.text, "new body");
    assert_eq!(f.requests[0].extra_lines, vec![ExtraLine::new("#~| old body")]);
    assert_eq!(serialize(&f), text);
}

fn multipart(text: &str, enabled: bool) -> Request {
    Request {
        method: "POST".into(),
        url: "https://x".into(),
        headers: KvSection {
            enabled: true,
            items: vec![KeyValue::new("Content-Type", "multipart/form-data; boundary=B")],
        },
        body: Body { enabled, mode: BodyMode::Multipart, text: text.into() },
        ..Default::default()
    }
}

const PART_A: &str = "--B\nContent-Disposition: form-data; name=\"a\"\n\n1";
const PART_B_OFF: &str = "#~ --B\n#~ Content-Disposition: form-data; name=\"b\"\n#~\n#~ 2";

#[test]
fn disabled_multipart_parts_are_written_in_the_header_area() {
    let r = multipart(&format!("{PART_A}\n{PART_B_OFF}\n--B--"), true);
    let (text, back) = round_trip(&r);
    assert_eq!(
        text,
        "###\n\
         POST https://x\n\
         Content-Type: multipart/form-data; boundary=B\n\
         #~= --B\n\
         #~= Content-Disposition: form-data; name=\"b\"\n\
         #~=\n\
         #~= 2\n\
         \n\
         --B\n\
         Content-Disposition: form-data; name=\"a\"\n\
         \n\
         1\n\
         --B--\n"
    );
    assert_eq!(back, r);
}

#[test]
fn disabled_multipart_parts_reload_before_the_closing_boundary() {
    // A part disabled in the middle comes back after the enabled ones (documented).
    let r = multipart(&format!("{PART_B_OFF}\n{PART_A}\n--B--"), true);
    let (_, back) = round_trip(&r);
    assert_eq!(back.body.text, format!("{PART_A}\n{PART_B_OFF}\n--B--"));
}

#[test]
fn disabled_parts_inside_a_disabled_body_keep_their_own_state() {
    let r = multipart(&format!("{PART_A}\n{PART_B_OFF}\n--B--"), false);
    let (text, back) = round_trip(&r);
    assert!(text.contains("\n#~| --B\n"), "{text}");
    assert!(
        text.contains("\n#~| #~ --B\n#~| #~ Content-Disposition: form-data; name=\"b\"\n#~| #~\n#~| #~ 2\n"),
        "{text}"
    );
    assert!(!text.contains("#~="), "{text}");
    assert_eq!(back, r);
}

#[test]
fn disabled_form_fields_stay_in_the_body() {
    let mut r = multipart("#~ a=1\nb=2\n#~ &c=3\n# a note\n&d=4", true);
    r.headers.items[0].value = "application/x-www-form-urlencoded".into();
    r.body.mode = BodyMode::FormUrlEncoded;
    let (text, back) = round_trip(&r);
    assert!(text.ends_with("\n\n#~ a=1\nb=2\n#~ &c=3\n# a note\n&d=4\n"), "{text}");
    assert_eq!(back, r);
}

#[test]
fn disabled_form_fields_inside_a_disabled_body_keep_their_own_state() {
    let mut r = multipart("a=1\n#~ &b=2", false);
    r.headers.items[0].value = "application/x-www-form-urlencoded".into();
    r.body.mode = BodyMode::FormUrlEncoded;
    let (text, back) = round_trip(&r);
    assert!(text.ends_with("\n#~| a=1\n#~| #~ &b=2\n"), "{text}");
    assert_eq!(back, r);
}

#[test]
fn untouched_bodies_with_disabled_fields_and_comments_save_byte_identical() {
    let text = "### Form\n\
        POST https://x\n\
        Content-Type: application/x-www-form-urlencoded\n\
        \n\
        #~ a=1\n\
        // why b\n\
        b=2\n\
        #~ &c=3\n\
        \n\
        ### Parts\n\
        POST https://x\n\
        Content-Type: multipart/form-data; boundary=B\n\
        #~= --B\n\
        #~= Content-Disposition: form-data; name=\"off\"\n\
        #~=\n\
        #~= 1\n\
        \n\
        --B\n\
        Content-Disposition: form-data; name=\"note\"\n\
        \n\
        # a value line, not a comment\n\
        // also content\n\
        --B--\n";
    let f = parse(text);
    assert_eq!(f.requests[1].body.text.lines().filter(|l| l.starts_with("#~")).count(), 4);
    assert_eq!(serialize(&f), text);

    // Edited, the parts request is re-rendered with the same layout.
    let mut edited = parse(text);
    edited.requests[1].url = "https://y".into();
    assert_eq!(
        serialize(&edited),
        text.replace("POST https://x\nContent-Type: multipart", "POST https://y\nContent-Type: multipart")
    );
}

#[test]
fn disabled_part_lines_next_to_a_non_multipart_body_are_kept() {
    let text = "POST https://x\nContent-Type: text/plain\n#~= --B\n\nhello\n";
    let f = parse(text);
    assert_eq!(f.requests[0].body.text, "hello");
    assert_eq!(f.requests[0].extra_lines, vec![ExtraLine::new("#~= --B")]);
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
    assert!(out.ends_with("GET https://example.org/pets\n\n### New\nGET https://new\n"), "{out}");
    let back = parse(&out);
    assert_eq!(back.requests.len(), 8);
}

#[test]
fn param_and_header_docs_attach_to_items_and_round_trip() {
    let text = "### Active alerts\n\
# Returns all currently active alerts\n\
# @name alerts_active\n\
# @param area: State or marine area code\n\
# @param area: e.g. KS\n\
# @header user-agent: Identify your app\n\
# @param missing: Documents nothing\n\
GET https://api.weather.gov/alerts/active?limit=5\n\
#~ &area=KS\n\
User-Agent: HttpDesk\n";
    let f = parse(text);
    let r = &f.requests[0];
    assert_eq!(r.comments, ["Returns all currently active alerts"]);
    let area = r.query.items.iter().find(|i| i.name == "area").unwrap();
    assert!(!area.enabled);
    assert_eq!(area.description, "State or marine area code\ne.g. KS");
    assert_eq!(r.query.items.iter().find(|i| i.name == "limit").unwrap().description, "");
    assert_eq!(r.headers.items[0].description, "Identify your app", "header names match case-insensitively");
    // Docs that match no item are kept, not dropped.
    assert!(r.directives.iter().any(|d| d.name == "param" && d.value == "missing: Documents nothing"));

    // Untouched: byte-for-byte.
    assert_eq!(serialize(&f), text);

    // Edited: docs are rendered from the items, above the request line.
    let mut f = f;
    f.requests[0].query.items[0].description = "Max results".into();
    let out = serialize(&f);
    assert!(out.contains("# @param limit: Max results\n# @param area: State or marine area code\n# @param area: e.g. KS\n# @header User-Agent: Identify your app\n"), "{out}");
    assert!(out.contains("# @param missing: Documents nothing\n"));
    let back = parse(&out);
    assert_eq!(back.requests[0].query.items, f.requests[0].query.items);
    assert_eq!(back.requests[0].headers.items, f.requests[0].headers.items);
}

#[test]
fn doc_lines_stay_above_the_request_line() {
    // Docs between query or header lines break JetBrains (research Appendix B),
    // so every doc line must come before the method line.
    let mut req = Request { name: "X".into(), method: "GET".into(), url: "https://x".into(), ..Default::default() };
    req.query.items.push(KeyValue { description: "Q doc".into(), ..KeyValue::disabled("q", "1") });
    req.headers.items.push(KeyValue { description: "H doc".into(), ..KeyValue::new("X-A", "1") });
    let out = render_request(&req);
    let method_line = out.lines().position(|l| l.starts_with("GET ")).unwrap();
    for (i, l) in out.lines().enumerate() {
        if l.starts_with("# @param") || l.starts_with("# @header") {
            assert!(i < method_line, "{out}");
        }
    }
}

// ---------------------------------------------------------------- byte fidelity

#[test]
fn utf8_bom_is_stripped_for_parsing_and_written_back() {
    let text = "\u{FEFF}### First\nGET https://x\n\n### Second\nGET https://y\n";
    let mut f = parse(text);
    assert_eq!(f.requests[0].name, "First");
    assert_eq!(f.requests[0].url, "https://x");
    assert_eq!(serialize(&f), text);

    f.requests[0].url = "https://z".into();
    assert_eq!(serialize(&f), "\u{FEFF}### First\nGET https://z\n\n### Second\nGET https://y\n");

    // A `###`-less first request after a BOM is still a request, not a header.
    let f = parse("\u{FEFF}GET https://x\n");
    assert_eq!((f.requests.len(), f.requests[0].url.as_str()), (1, "https://x"));
    assert!(!serialize(&parse("GET https://x\n")).starts_with('\u{FEFF}'));
}

#[test]
fn mixed_line_endings_are_saved_with_the_dominant_ending() {
    // Mostly LF with one stray CRLF.
    let f = parse("### A\nGET https://x\nAccept: */*\r\n\n### B\nGET https://y\n");
    assert_eq!(serialize(&f), "### A\nGET https://x\nAccept: */*\n\n### B\nGET https://y\n");

    // Mostly CRLF with one stray LF.
    let f = parse("### A\r\nGET https://x\nAccept: */*\r\n\r\n### B\r\nGET https://y\r\n");
    assert_eq!(serialize(&f), "### A\r\nGET https://x\r\nAccept: */*\r\n\r\n### B\r\nGET https://y\r\n");
}

#[test]
fn requests_placed_before_a_separatorless_first_request_stay_separate() {
    let text = "# @name first\nGET https://x\nAccept: */*\n";

    // Insert a new request at the top.
    let mut f = parse(text);
    f.requests.insert(0, Request { name: "New".into(), url: "https://new".into(), ..Default::default() });
    let out = serialize(&f);
    assert_eq!(out, "### New\nGET https://new\n\n###\n# @name first\nGET https://x\nAccept: */*\n");
    let urls: Vec<_> = parse(&out).requests.iter().map(|r| r.url.clone()).collect();
    assert_eq!(urls, ["https://new", "https://x"]);

    // Duplicate the first request (the copy still carries the original text) in front of it.
    let mut f = parse(text);
    let copy = f.requests[0].clone();
    f.requests.insert(0, copy);
    let out = serialize(&f);
    assert_eq!(out, "# @name first\nGET https://x\nAccept: */*\n###\n# @name first\nGET https://x\nAccept: */*\n");
    assert_eq!(parse(&out).requests.len(), 2);
}

/// Parses `text`, edits its first request so it is re-rendered, and returns the output.
fn resave(text: &str) -> String {
    let mut f = parse(text);
    f.requests[0].method = "PUT".into();
    serialize(&f)
}

#[test]
fn empty_param_docs_survive_a_resave() {
    let out = resave("# @param a:\n# @header Accept:\nGET https://x?a=1\nAccept: */*\n");
    assert!(out.contains("# @param a:\n# @header Accept:\nPUT "), "{out}");
}

#[test]
fn unknown_httpdesk_directive_values_survive_a_resave() {
    let out = resave("# @httpdesk-auth oauth2 client-credentials\nGET https://x\n");
    assert!(out.contains("# @httpdesk-auth oauth2 client-credentials\nPUT "), "{out}");

    // Unknown section names are kept next to the known ones.
    let out = resave("# @httpdesk-disabled headers, cookies\nGET https://x\n#~ A: 1\n");
    assert!(out.contains("# @httpdesk-disabled headers, cookies\nPUT "), "{out}");
    assert!(!parse(&out).requests[0].headers.enabled);

    let out = resave("# @httpdesk-disabled cookies\nGET https://x\n");
    assert!(out.contains("# @httpdesk-disabled cookies\nPUT "), "{out}");
}

#[test]
fn section_directive_keeps_its_order_on_resave() {
    let out = resave("# @httpdesk-disabled headers, query\nGET https://x\n#~ &a=1\n#~ A: 1\n");
    assert!(out.starts_with("###\n# @httpdesk-disabled headers, query\nPUT "), "{out}");

    let out = resave("# @httpdesk-disabled cookies, headers\nGET https://x\n#~ A: 1\n");
    assert!(out.starts_with("###\n# @httpdesk-disabled cookies, headers\nPUT "), "{out}");

    // Sections turned off by the edit go after the ones already listed; ones turned on are dropped.
    let mut f = parse("# @httpdesk-disabled cookies, headers\nGET https://x?a=1\n#~ A: 1\n");
    f.requests[0].headers.enabled = true;
    f.requests[0].query.enabled = false;
    let out = serialize(&f);
    assert!(out.starts_with("###\n# @httpdesk-disabled cookies, query\nGET "), "{out}");

    // An unedited request with a non-canonical order is still written byte for byte.
    let text = "### A\n# @httpdesk-disabled headers, query\nGET https://x\n#~ &a=1\n#~ A: 1\n";
    assert_eq!(serialize(&parse(text)), text);
}

#[test]
fn a_header_of_only_blank_lines_is_kept() {
    let text = "\n\n### A\nGET https://x\n";
    assert_eq!(serialize(&parse(text)), text);
    assert_eq!(resave(text), "\n\n### A\nPUT https://x\n");
}

#[test]
fn header_area_comments_keep_their_position_on_resave() {
    let text = "GET https://x?a=1\n\
# about b\n\
#~ &b=2\n\
# credentials\n\
Authorization: Bearer t\n\
Accept: */*\n\
# why X-Two\n\
# second line\n\
X-Two: 2\n\
# trailing note\n";
    assert_eq!(
        resave(text),
        "###\n\
PUT https://x?a=1\n\
# about b\n\
#~ &b=2\n\
# credentials\n\
Authorization: Bearer t\n\
Accept: */*\n\
# why X-Two\n\
# second line\n\
X-Two: 2\n\
# trailing note\n"
    );

    // A comment whose header is removed moves to the end rather than being dropped.
    let mut f = parse(text);
    f.requests[0].headers.items.retain(|h| h.name != "X-Two");
    let out = serialize(&f);
    assert!(out.ends_with("Accept: */*\n# why X-Two\n# second line\n# trailing note\n"), "{out}");
}

#[test]
fn file_header_layout_survives_variable_edits() {
    let text = "# Shared settings\n\n@host = https://x\n@token=abc\n\n# Ids\n@id = 1\n\n\n### First\nGET {{host}}\n";
    let edit = |f: &mut HttpFile| {
        f.header.variables[1].value = "xyz".into();
        f.header.variables.retain(|v| v.name != "id");
        f.header.variables.push(Variable { name: "new".into(), value: "2".into() });
    };
    let mut f = parse(text);
    edit(&mut f);
    assert_eq!(
        serialize(&f),
        "# Shared settings\n\n@host = https://x\n@token = xyz\n\n# Ids\n@new = 2\n\n\n### First\nGET {{host}}\n"
    );
}

// ---------------------------------------------------------------- query escaping (ADR-0001)

fn with_query(items: Vec<KeyValue>) -> Request {
    Request {
        method: "GET".into(),
        url: "https://x/s".into(),
        query: KvSection { enabled: true, items },
        ..Default::default()
    }
}

#[test]
fn query_values_with_structure_characters_round_trip_as_one_param() {
    let r = with_query(vec![KeyValue::new("q", "a&b=c"), KeyValue::disabled("off", "x&y")]);
    let (text, back) = round_trip(&r);
    assert!(text.contains("GET https://x/s?q=a%26b=c\n"), "only `&` is escaped in a value: {text}");
    assert!(text.contains("\n#~ &off=x%26y\n"), "{text}");
    assert_eq!(back.query.items, r.query.items);
}

#[test]
fn query_values_with_spaces_hash_and_percent_round_trip_exactly() {
    let r = with_query(vec![
        KeyValue::new("q", "two  spaces "),
        KeyValue::new("tag", "#1"),
        KeyValue::new("pct", "100% of %20 and %zz"),
        KeyValue::new("a=b&c d", "{{ term }}"),
        KeyValue::new("nb", "a\u{a0}b\tc"),
    ]);
    let (text, back) = round_trip(&r);
    assert!(
        text.contains("GET https://x/s?q=two%20%20spaces%20&tag=%231&pct=100%25%20of%20%2520%20and%20%zz&a%3Db%26c%20d={{ term }}&nb=a%C2%A0b%09c\n"),
        "{text}"
    );
    assert_eq!(back.query.items, r.query.items);
}

#[test]
fn hand_written_query_escapes_are_kept_on_resave() {
    let out = resave("GET https://x/s?email=a%40b.c&path=%2Fhome&q=a%20b\n");
    assert_eq!(out, "###\nPUT https://x/s?email=a%40b.c&path=%2Fhome&q=a%20b\n");
    let req = parse(&out).requests.remove(0);
    assert_eq!(req.query.items[0].value, "a%40b.c", "escapes that don't affect structure are shown as written");
    assert_eq!(req.query.items[2].value, "a b");
}

#[test]
fn an_empty_value_keeps_its_equals_sign() {
    let out = resave("GET https://x/s?flag=&bare\n#~ &off=\n");
    assert_eq!(out, "###\nPUT https://x/s?flag=&bare\n#~ &off=\n");
}

// ---------------------------------------------------------------- field safety

#[test]
fn multi_line_descriptions_save_as_one_comment_line_per_line() {
    let mut f = parse("### A\nGET https://x\n");
    f.requests[0].comments = vec!["First line\nsecond line".into()];
    let out = try_serialize(&f).unwrap();
    assert_eq!(out, "### A\n# First line\n# second line\nGET https://x\n");
    let back = parse(&out);
    assert_eq!(back.requests.len(), 1);
    assert_eq!(back.requests[0].comments, ["First line", "second line"]);
    assert_eq!(back.requests[0].url, "https://x");

    // CRLF and a lone CR count as line breaks too; blank lines stay as `#`.
    f.requests[0].comments = vec!["a\r\n\rb".into()];
    assert_eq!(try_serialize(&f).unwrap(), "### A\n# a\n#\n# b\nGET https://x\n");
}

#[test]
fn description_lines_starting_with_at_reload_as_description() {
    let mut f = parse("### A\n# @name a\nGET https://x\n");
    f.requests[0].comments =
        vec!["Uses:".into(), "@timeout 1".into(), "  @no-redirect".into(), "@ already safe".into(), "@".into()];
    let out = try_serialize(&f).unwrap();
    // The same `@ ` spacing the OpenAPI generator uses.
    assert_eq!(
        out,
        "### A\n# Uses:\n# @ timeout 1\n#   @ no-redirect\n# @ already safe\n# @\n# @name a\nGET https://x\n"
    );
    let back = &parse(&out).requests[0];
    assert_eq!(back.comments, ["Uses:", "@ timeout 1", "  @ no-redirect", "@ already safe", "@"]);
    let directives: Vec<_> = back.directives.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(directives, ["name"], "{out}");
}

#[test]
fn indented_description_lines_are_never_directives() {
    let req =
        &parse("#   @timeout 5\n//  @no-redirect\n#\t@no-log\n# @name a\n#@no-cookie-jar\nGET https://x\n").requests[0];
    assert_eq!(req.comments, ["  @timeout 5", " @no-redirect", "\t@no-log"]);
    let directives: Vec<_> = req.directives.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(directives, ["name", "no-cookie-jar"]);
}

#[test]
fn only_column_zero_handler_lines_end_the_body() {
    // JetBrains reads `>` / `>>` as a handler only at the start of a line.
    let text = "POST https://x\n\nquote:\n  > {% not a script %}\n  >> not.txt\n\n> {% client.log(1) %}\n";
    let req = &parse(text).requests[0];
    assert_eq!(req.body.text, "quote:\n  > {% not a script %}\n  >> not.txt");
    assert_eq!(req.response_handler.as_deref(), Some("> {% client.log(1) %}"));
}

const EDITABLE: &str = "@host = https://x\n\n### List pets\n# @timeout 5\n@id = 1\nGET {{host}}/pets?limit=20\nAuthorization: Bearer t\nAccept: */*\n";

/// A model edit for the table-driven save tests.
type Edit = Box<dyn FnOnce(&mut HttpFile)>;

/// Applies `edit` to a parsed `EDITABLE` and returns the save error.
fn save_error(edit: impl FnOnce(&mut HttpFile)) -> String {
    let mut f = parse(EDITABLE);
    edit(&mut f);
    match try_serialize(&f) {
        Ok(text) => panic!("saved:\n{text}"),
        Err(e) => e.to_string(),
    }
}

#[test]
fn save_refuses_line_breaks_in_single_line_fields() {
    assert_eq!(try_serialize(&parse(EDITABLE)).unwrap(), EDITABLE);

    let cases: Vec<(Edit, &str)> = vec![
        (
            Box::new(|f| f.requests[0].name = "List\npets".into()),
            "Request \"List\\npets\": the name contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].value = "*/*\nX-Evil: 1".into()),
            "Request \"List pets\": the value of header \"Accept\" contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "Acc\nept".into()),
            "Request \"List pets\": header name \"Acc\\nept\" contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].query.items[0].value = "20\r".into()),
            "Request \"List pets\": the value of query param \"limit\" contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].query.items[0].name = "li\nmit".into()),
            "Request \"List pets\": query param name \"li\\nmit\" contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].url = "{{host}}\n/pets".into()),
            "Request \"List pets\": the URL contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].method = "GET\n".into()),
            "Request \"List pets\": the method contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].auth.token = "t\nX: 1".into()),
            "Request \"List pets\": the bearer token contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].variables[0].value = "1\n2".into()),
            "Request \"List pets\": the value of variable \"id\" contains a line break",
        ),
        (
            Box::new(|f| f.requests[0].directives[0].value = "5\nGET https://evil".into()),
            "Request \"List pets\": directive @timeout contains a line break",
        ),
        (
            Box::new(|f| f.header.variables[0].value = "https://x\n### Injected".into()),
            "File variables: the value of variable \"host\" contains a line break",
        ),
    ];
    for (edit, want) in cases {
        assert_eq!(save_error(edit), want);
    }
}

#[test]
fn save_refuses_names_that_would_read_back_as_something_else() {
    for text in [JETBRAINS, VSCODE] {
        assert!(try_serialize(&parse(text)).is_ok());
    }

    let cases: Vec<(Edit, &str)> = vec![
        // `@my var = 1` isn't a variable line; in a request it would become the request line.
        (
            Box::new(|f| f.requests[0].variables[0].name = "my id".into()),
            "Request \"List pets\": variable name \"my id\" can only use letters, digits, _, -, . and $",
        ),
        (
            Box::new(|f| f.header.variables[0].name = "base=url".into()),
            "File variables: variable name \"base=url\" can only use letters, digits, _, -, . and $",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "X Trace".into()),
            "Request \"List pets\": header name \"X Trace\" can't contain spaces",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "X:Trace".into()),
            "Request \"List pets\": header name \"X:Trace\" can't contain ':'",
        ),
        // Read back as a comment, a disabled item or a disabled body line.
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "#Trace".into()),
            "Request \"List pets\": header name \"#Trace\" can't start with '#'",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "//Trace".into()),
            "Request \"List pets\": header name \"//Trace\" can't start with '//'",
        ),
        (
            Box::new(|f| f.requests[0].headers.items[0].name = "|Trace".into()),
            "Request \"List pets\": header name \"|Trace\" can't start with '|'",
        ),
        (
            Box::new(|f| {
                let auth = &mut f.requests[0].auth;
                (auth.kind, auth.key_name, auth.key_location) =
                    (AuthKind::ApiKey, "X Key".into(), ApiKeyLocation::Header);
            }),
            "Request \"List pets\": API key header name \"X Key\" can't contain spaces",
        ),
        (
            Box::new(|f| {
                let auth = &mut f.requests[0].auth;
                (auth.kind, auth.key_name, auth.key_location) =
                    (AuthKind::ApiKey, "api key".into(), ApiKeyLocation::Query);
            }),
            "Request \"List pets\": the API key name \"api key\" can't contain spaces",
        ),
        // The request line splits at whitespace.
        (
            Box::new(|f| f.requests[0].method = "GET X".into()),
            "Request \"List pets\": the method \"GET X\" can't contain spaces",
        ),
        // `# @param a:b: text` would attach the description to `a`.
        (
            Box::new(|f| {
                let p = &mut f.requests[0].query.items[0];
                (p.name, p.description) = ("a:b".into(), "Page size".into());
            }),
            "Request \"List pets\": query param name \"a:b\" can't contain ':' while it has a description",
        ),
        // RFC 7617: the username ends at the first `:`.
        (
            Box::new(|f| {
                let auth = &mut f.requests[0].auth;
                (auth.kind, auth.username, auth.password, auth.raw) =
                    (AuthKind::Basic, "dom:ain".into(), "pw".into(), None);
            }),
            "Request \"List pets\": the Basic auth username \"dom:ain\" can't contain ':'",
        ),
    ];
    for (edit, want) in cases {
        assert_eq!(save_error(edit), want);
    }

    // Names that read back unchanged are fine, as is a disabled header with an odd name.
    let mut f = parse(EDITABLE);
    f.requests[0].variables[0].name = "$pet.id-2_x".into();
    f.requests[0].headers.items[0].name = "{{headerName}}".into();
    f.requests[0].headers.items.push(KeyValue::disabled("X-Ok!", "1"));
    f.requests[0].query.items.push(KeyValue::new("a:b", "1"));
    let out = try_serialize(&f).unwrap();
    let back = &parse(&out).requests[0];
    assert_eq!(back.variables[0].name, "$pet.id-2_x");
    assert_eq!(back.headers.items[0].name, "{{headerName}}");
    assert_eq!(back.headers.items[1], KeyValue::disabled("X-Ok!", "1"));
    assert_eq!(back.query.items[1].name, "a:b", "a ':' is fine in a param without a description");
}
