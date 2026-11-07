//! The resolved preview (`exec::preview`) shows what a send would send, without
//! sending, generating dynamic variables or reading body files.

use std::collections::HashMap;
use std::path::Path;

use httpdesk_core::exec::{prepare, preview, ExecSettings};
use httpdesk_core::vars::Resolver;
use httpdesk_core::*;

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn request(text: &str) -> Request {
    parse(text).requests.remove(0)
}

#[test]
fn preview_shows_the_method_url_and_headers_send_would_produce() {
    let env = vars(&[
        ("baseUrl", "https://api.example.com/v1"),
        ("token", "t0k&n"),
        ("q", "a&b=c #d"),
        ("user", "alice"),
        ("pass", "s3cret"),
        ("apiHost", "api.local:8080"),
    ]);
    let cases = [
        "GET {{baseUrl}}/pets?q={{q}}&limit=10\nAccept: application/json\n# X-Off: no\n",
        "# @no-auto-encoding\nGET {{baseUrl}}/pets?q={{q}}\n",
        "post {{baseUrl}}/pets\nAuthorization: Bearer {{token}}\n\n{\"name\": \"{{user}}\"}\n",
        "POST {{baseUrl}}/form\nContent-Type: application/x-www-form-urlencoded\n\na={{q}}\n&b=2\n",
        "PUT {{baseUrl}}/x\nContent-Type: text/csv\nUser-Agent: mine\nAccept-Encoding: identity\n\na,b\n",
        "GET /relative?id=1\nHost: {{apiHost}}\n",
        "GET example.com/no-scheme\n",
        "GET {{baseUrl}}/unknown/{{id}}?id={{id}}\nX-Id: {{id}}\n",
        "POST {{baseUrl}}/x\n\n{\"a\": \"{{inBody}}\"}\n",
        "POST {{baseUrl}}/x\nContent-Type: multipart/form-data; boundary=b\n\n--b\n#~ X-Off: {{off}}\nX-On: {{on}}\n--b--\n",
    ];
    for text in cases {
        let mut reqs = vec![request(text)];
        // Every kind of auth on a plain GET.
        if text.starts_with("GET {{baseUrl}}/pets?") {
            for (kind, location) in [
                (AuthKind::Basic, ApiKeyLocation::Header),
                (AuthKind::Bearer, ApiKeyLocation::Header),
                (AuthKind::ApiKey, ApiKeyLocation::Header),
                (AuthKind::ApiKey, ApiKeyLocation::Query),
            ] {
                let mut r = request(text);
                r.auth = Auth {
                    enabled: true,
                    kind,
                    username: "{{user}}".into(),
                    password: "{{pass}}".into(),
                    token: " {{token}} ".into(),
                    key_name: "X-Api-Key".into(),
                    key_value: "{{q}}".into(),
                    key_location: location,
                    ..Default::default()
                };
                reqs.push(r);
            }
        }
        for req in reqs {
            let sent = prepare(&req, &Resolver::new(env.clone()), Path::new("."), &ExecSettings::default()).unwrap();
            let shown = preview(&req, Resolver::new(env.clone()));
            assert_eq!(
                (&shown.method, &shown.url, &shown.headers),
                (&sent.method, &sent.url, &sent.headers),
                "preview and send disagree for:\n{text}\nauth: {:?}",
                req.auth.kind
            );
            assert_eq!(shown.warnings, sent.warnings, "{text}");
            assert!(shown.error.is_none(), "{text}");
        }
    }
}

#[test]
fn dynamic_variables_are_shown_as_placeholders_never_generated() {
    let env = vars(&[("id", "{{$uuid}}"), ("host", "x.io")]);
    let mut req = request(
        "POST https://{{host}}/items/{{$uuid}}?ts={{$timestamp}}&n={{ $randomInt 1 9 }}&id={{id}}\n\
         X-Request-Id: {{id}}\n\
         X-When: {{$datetime iso8601}}\n",
    );
    req.auth = Auth { kind: AuthKind::Bearer, token: "{{$random.hexadecimal 16}}".into(), ..Default::default() };
    let shown = preview(&req, Resolver::new(env));
    assert_eq!(shown.url, "https://x.io/items/{{$uuid}}?ts={{$timestamp}}&n={{ $randomInt 1 9 }}&id={{$uuid}}");
    let header = |name: &str| shown.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!(header("X-Request-Id"), Some("{{$uuid}}"), "nested in a variable's value");
    assert_eq!(header("X-When"), Some("{{$datetime iso8601}}"));
    assert_eq!(header("Authorization"), Some("Bearer {{$random.hexadecimal 16}}"));
    assert!(shown.warnings.is_empty(), "placeholders aren't undefined: {:?}", shown.warnings);
    assert!(shown.error.is_none());

    // Not evaluated, so bad arguments and a dynamic host aren't errors here (the send reports them).
    let req = request("GET https://{{$random.alphabetic 6}}.example.com/?n={{$randomInt 10 5}}\n");
    let shown = preview(&req, Resolver::new(HashMap::new()));
    assert_eq!(shown.url, "https://{{$random.alphabetic 6}}.example.com/?n={{$randomInt 10 5}}");
    assert!(shown.error.is_none(), "{:?}", shown.error);
}

#[test]
fn the_body_implies_a_content_type_but_no_file_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let content_type = |req: &Request| {
        let shown = preview(req, Resolver::new(HashMap::new()));
        assert!(shown.error.is_none(), "{:?}", shown.error);
        shown.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.clone())
    };

    // A JSON body read from a file that doesn't exist: send fails, the preview doesn't.
    let mut req = request("POST https://x.io/a\n\n{}\n");
    req.body.text = "< ./missing.json".into();
    assert!(prepare(&req, &Resolver::new(HashMap::new()), dir.path(), &ExecSettings::default()).is_err());
    assert_eq!(content_type(&req).as_deref(), Some("application/json"));

    // The request's own Content-Type wins; a disabled or blank body implies none.
    let req = request("POST https://x.io/a\nContent-Type: application/vnd.api+json\n\n{}\n");
    assert_eq!(content_type(&req).as_deref(), Some("application/vnd.api+json"));
    let mut req = request("POST https://x.io/a\n\n<a/>\n");
    assert_eq!(content_type(&req).as_deref(), Some("application/xml"));
    req.body.enabled = false;
    assert_eq!(content_type(&req), None);
    let req = request("POST https://x.io/a\n\n< ./upload.bin\n");
    assert_eq!(content_type(&req), None, "a file body (mode File) implies nothing, as at send");
}

#[test]
fn the_authorization_section_shows_each_field_resolved() {
    let env = vars(&[("user", "alice"), ("pass", "s3cret"), ("token", "t0k"), ("key", "k3y")]);
    let auth = |kind, location| Auth {
        kind,
        username: "{{user}}".into(),
        password: "{{pass}}".into(),
        token: "{{token}}".into(),
        key_name: "X-Api-Key".into(),
        key_value: "{{key}}".into(),
        key_location: location,
        ..Default::default()
    };
    let fields = |auth: Auth| {
        let mut req = request("GET https://x.io/\n");
        req.auth = auth;
        let shown = preview(&req, Resolver::new(env.clone()));
        shown.auth.into_iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>()
    };
    assert_eq!(fields(auth(AuthKind::Basic, ApiKeyLocation::Header)), ["Username=alice", "Password=s3cret"]);
    assert_eq!(fields(auth(AuthKind::Bearer, ApiKeyLocation::Header)), ["Token=t0k"]);
    assert_eq!(fields(auth(AuthKind::ApiKey, ApiKeyLocation::Query)), ["Key=X-Api-Key", "Value=k3y"]);
    assert!(fields(auth(AuthKind::None, ApiKeyLocation::Header)).is_empty());
    assert!(fields(Auth { enabled: false, ..auth(AuthKind::Bearer, ApiKeyLocation::Header) }).is_empty());

    // Base64 would hide a placeholder, so Basic credentials holding one are shown unencoded.
    let mut req = request("GET https://x.io/\n");
    req.auth = Auth { password: "{{$uuid}}".into(), ..auth(AuthKind::Basic, ApiKeyLocation::Header) };
    let shown = preview(&req, Resolver::new(env.clone()));
    assert_eq!(shown.auth[1], ("Password".to_string(), "{{$uuid}}".to_string()));
    assert_eq!(shown.headers[0], ("Authorization".to_string(), "Basic base64(alice:{{$uuid}})".to_string()));
}

#[test]
fn a_request_that_cant_be_sent_is_still_shown_with_the_reason() {
    let shown = preview(&request("GET {{baseUrl}}/users?id={{id}}\n"), Resolver::new(HashMap::new()));
    assert_eq!(shown.url, "{{baseUrl}}/users?id=%7B%7Bid%7D%7D", "as the send would build it");
    assert_eq!(shown.warnings, ["Unresolved variables: baseUrl, id"]);
    let error = serde_json::to_value(shown.error.expect("an undefined host can't be sent")).unwrap();
    assert_eq!(
        (&error["kind"], &error["details"]["names"]),
        (&"unresolvedVariable".into(), &serde_json::json!(["baseUrl"]))
    );

    let req = request("GET {{base}}/users\n");
    let env = vars(&[("base", "{{host}}"), ("host", "{{base}}")]);
    let sent = prepare(&req, &Resolver::new(env.clone()), Path::new("."), &ExecSettings::default()).unwrap_err();
    let shown = preview(&req, Resolver::new(env));
    assert_eq!(shown.url, "{{base}}/users");
    assert_eq!(shown.warnings, ["Circular variable reference: base → host → base"]);
    let error = serde_json::to_value(shown.error.expect("a circular host can't be sent")).unwrap();
    assert_eq!(error, serde_json::to_value(sent).unwrap(), "the same error as the send");
    assert_eq!(error["kind"], "circularVariable");

    let shown = preview(&request("GET /users\n"), Resolver::new(HashMap::new()));
    assert_eq!(shown.url, "/users");
    assert!(shown.error.unwrap().to_string().contains("Host header"));
}

#[test]
fn prompted_values_are_shown_masked_ones_masked_and_unanswered_prompts_as_written() {
    let req = request(
        "# @prompt host\n# @prompt password\n# @prompt otp One-time code\nGET https://{{host}}/login?otp={{otp}}\nX-Pass: {{password}}\nX-Env: {{envOnly}}\n",
    );
    let env = vars(&[("host", "env.example"), ("envOnly", "{{host}}")]);
    let answers = vars(&[("host", "typed.example"), ("password", "s3cret")]);
    let resolver = Resolver::new(env).with_prompts(&req.prompts(), &answers);

    let shown = preview(&req, resolver);
    assert_eq!(shown.url, "https://typed.example/login?otp={{otp}}");
    let header = |name: &str| shown.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!(header("X-Pass"), Some("••••••••"), "never the masked value");
    assert_eq!(header("X-Env"), Some("typed.example"), "used inside other variables' values");
    assert!(shown.warnings.is_empty(), "an unanswered prompt isn't an Undefined variable: {:?}", shown.warnings);
    assert!(shown.error.is_none(), "{:?}", shown.error);

    // An unanswered prompt in the host doesn't stop the preview either.
    let req = request("# @prompt host\nGET https://{{host}}/x\n");
    let shown = preview(&req, Resolver::new(HashMap::new()).with_prompts(&req.prompts(), &HashMap::new()));
    assert_eq!((shown.url.as_str(), shown.error.is_none()), ("https://{{host}}/x", true));
}

#[test]
fn a_send_uses_prompted_values_including_masked_ones() {
    let req = request("# @prompt password\nGET https://x.example/?p={{password}}\n");
    let resolver =
        Resolver::new(vars(&[("password", "env")])).with_prompts(&req.prompts(), &vars(&[("password", "s3cret")]));
    let sent = prepare(&req, &resolver, Path::new("."), &ExecSettings::default()).unwrap();
    assert_eq!(sent.url, "https://x.example/?p=s3cret");
}
