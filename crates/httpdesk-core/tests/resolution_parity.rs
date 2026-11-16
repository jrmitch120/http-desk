//! The core resolver against the cases in `fixtures/resolution-cases.json`, which
//! `src/lib/vars.test.ts` also runs the frontend resolver through: if either
//! resolver drifts from the expected answers, its side fails. Env files are read from
//! disk the way a send reads them (`env::load_for` for the request's folder).

use httpdesk_core::env;
use std::collections::HashMap;

use httpdesk_core::exchange::{Exchange, Message, NamedExchanges};
use httpdesk_core::exec::HttpResponse;
use httpdesk_core::model::{Prompt, Variable};
use httpdesk_core::vars::Resolver;
use serde::Deserialize;

#[derive(Deserialize)]
struct Cases {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    case: String,
    #[serde(default)]
    env_files: EnvFiles,
    /// Env files of folders below the root, by relative path.
    #[serde(default)]
    folders: HashMap<String, EnvFiles>,
    /// The folder of the request's file, relative to the root.
    #[serde(default)]
    dir: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    file: Vec<Variable>,
    #[serde(default)]
    request: Vec<Variable>,
    /// The Session's Global variables.
    #[serde(default)]
    globals: HashMap<String, String>,
    /// What the request's pre-request script set with `request.variables.set`.
    #[serde(default)]
    pre_request: HashMap<String, String>,
    text: String,
    value: String,
    #[serde(default)]
    undefined: Vec<String>,
    #[serde(default)]
    circular: Vec<Vec<String>>,
    /// The request's Prompt variables; one with a `value` has been answered.
    #[serde(default)]
    prompts: Vec<PromptCase>,
    /// Unanswered prompts met: asked when sent.
    #[serde(default)]
    asked: Vec<String>,
    /// The file's `# @name`s.
    #[serde(default)]
    named: Vec<String>,
    /// The latest exchange of each named request that was sent.
    #[serde(default)]
    exchanges: HashMap<String, ExchangeCase>,
    /// The core's value, when it differs from the frontend's (it reads Request variables).
    #[serde(default)]
    core_value: Option<String>,
    /// Named requests Request variables read that haven't been sent.
    #[serde(default)]
    unsent: Vec<String>,
    /// Request variables whose path reads nothing.
    #[serde(default)]
    unmatched: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ExchangeCase {
    request: MessageCase,
    response: MessageCase,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct MessageCase {
    headers: Vec<(String, String)>,
    body: String,
    content_type: Option<String>,
}

impl MessageCase {
    fn message(&self) -> Message {
        Message {
            headers: self.headers.clone(),
            body: self.body.as_bytes().into(),
            content_type: self.content_type.clone(),
        }
    }

    /// The case as a response, with status 200, without its body.
    fn response(&self) -> HttpResponse {
        HttpResponse {
            status: 200,
            headers: self.headers.clone(),
            content_type: self.content_type.clone(),
            ..Default::default()
        }
    }
}

#[derive(Deserialize)]
struct PromptCase {
    name: String,
    value: Option<String>,
}

#[derive(Deserialize, Default)]
struct EnvFiles {
    public: Option<serde_json::Value>,
    private: Option<serde_json::Value>,
}

/// Whether `actual` is `expected` with each `{{$dynamic}}` in `expected` generated:
/// some text without braces in its place.
fn matches_with_dynamics(expected: &str, actual: &str) -> bool {
    let mut parts = expected.split("{{$");
    let first = parts.next().unwrap_or("");
    let Some(mut rest) = actual.strip_prefix(first) else { return false };
    for part in parts {
        let Some((_, literal)) = part.split_once("}}") else { return false };
        let generated_len = if literal.is_empty() { rest.len() } else { rest.find(literal).unwrap_or(0) };
        let generated = &rest[..generated_len];
        if generated.is_empty() || generated.contains(['{', '}']) || !rest[generated_len..].starts_with(literal) {
            return false;
        }
        rest = &rest[generated_len + literal.len()..];
    }
    rest.is_empty()
}

#[test]
fn the_core_resolver_gives_the_shared_answers() {
    let text =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/resolution-cases.json")).unwrap();
    let cases: Cases = serde_json::from_str(&text).unwrap();
    assert!(!cases.cases.is_empty());
    for c in cases.cases {
        let root = tempfile::tempdir().unwrap();
        for (folder, files) in std::iter::once(("", &c.env_files)).chain(c.folders.iter().map(|(d, f)| (d.as_str(), f)))
        {
            let dir = root.path().join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(public) = &files.public {
                std::fs::write(dir.join(env::ENV_FILE), public.to_string()).unwrap();
            }
            if let Some(private) = &files.private {
                std::fs::write(dir.join(env::PRIVATE_ENV_FILE), private.to_string()).unwrap();
            }
        }
        let dir = root.path().join(&c.dir);
        let set = env::load_for(root.path(), &dir).unwrap();
        let vars = env::variables(&set, c.environment.as_deref());
        let prompts: Vec<Prompt> =
            c.prompts.iter().map(|p| Prompt { name: p.name.clone(), description: String::new() }).collect();
        let answers: HashMap<String, String> =
            c.prompts.iter().filter_map(|p| Some((p.name.clone(), p.value.clone()?))).collect();
        let exchanges: NamedExchanges = c
            .named
            .iter()
            .map(|name| {
                let exchange = c.exchanges.get(name).map(|e| {
                    std::sync::Arc::new(Exchange {
                        request: e.request.message(),
                        shown: e.response.response(),
                        response_body: e.response.body.as_bytes().into(),
                        received: chrono::Utc::now(),
                    })
                });
                (name.clone(), exchange)
            })
            .collect();
        let r = Resolver::for_request(&vars, &c.file, &c.request, Some(&dir))
            .with_globals(c.globals.clone())
            .with_pre_request_variables(&c.pre_request)
            .with_prompts(&prompts, &answers)
            .with_request_variables(exchanges);
        let value = r.resolve(&c.text);
        let expected = c.core_value.as_ref().unwrap_or(&c.value);
        assert!(
            &value == expected || matches_with_dynamics(expected, &value),
            "{}: got {value:?}, expected {expected:?}",
            c.case,
        );
        assert_eq!(r.undefined(), c.undefined, "{}: undefined", c.case);
        assert_eq!(r.circular(), c.circular, "{}: circular", c.case);
        assert_eq!(r.unanswered(), c.asked, "{}: asked", c.case);
        assert_eq!(r.unsent(), c.unsent, "{}: unsent", c.case);
        let unmatched: Vec<String> = r.unmatched().into_iter().map(|u| u.reference).collect();
        assert_eq!(unmatched, c.unmatched, "{}: unmatched", c.case);
        assert!(r.errors().is_empty(), "{}: {:?}", c.case, r.errors());
    }
}

#[test]
fn dynamic_placeholders_match_only_generated_text() {
    assert!(matches_with_dynamics("a/{{$uuid}}?r=x-{{$randomInt 1 2}}", "a/1234?r=x-1"));
    assert!(matches_with_dynamics("plain", "plain"));
    assert!(!matches_with_dynamics("a/{{$uuid}}", "a/{{$uuid}}"));
    assert!(!matches_with_dynamics("a/{{$uuid}}", "a/"));
    assert!(!matches_with_dynamics("a/{{$uuid}}/b", "a/x/c"));
}
