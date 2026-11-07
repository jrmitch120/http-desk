//! The core resolver against the cases in `fixtures/resolution-cases.json`, which
//! `src/lib/vars.test.ts` also runs the frontend resolver through: if either
//! resolver drifts from the expected answers, its side fails.

use httpdesk_core::env;
use std::collections::HashMap;

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
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    file: Vec<Variable>,
    #[serde(default)]
    request: Vec<Variable>,
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
        let dir = tempfile::tempdir().unwrap();
        if let Some(public) = &c.env_files.public {
            std::fs::write(dir.path().join(env::ENV_FILE), public.to_string()).unwrap();
        }
        if let Some(private) = &c.env_files.private {
            std::fs::write(dir.path().join(env::PRIVATE_ENV_FILE), private.to_string()).unwrap();
        }
        let set = env::load(dir.path()).unwrap();
        let vars = env::variables(&set, c.environment.as_deref());
        let prompts: Vec<Prompt> =
            c.prompts.iter().map(|p| Prompt { name: p.name.clone(), description: String::new() }).collect();
        let answers: HashMap<String, String> =
            c.prompts.iter().filter_map(|p| Some((p.name.clone(), p.value.clone()?))).collect();
        let r = Resolver::for_request(&vars, &c.file, &c.request, Some(dir.path())).with_prompts(&prompts, &answers);
        let value = r.resolve(&c.text);
        assert!(matches_with_dynamics(&c.value, &value), "{}: got {value:?}, expected {:?}", c.case, c.value);
        assert_eq!(r.unresolved(), c.undefined, "{}: undefined", c.case);
        assert_eq!(r.circular(), c.circular, "{}: circular", c.case);
        assert_eq!(r.unanswered(), c.asked, "{}: asked", c.case);
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
