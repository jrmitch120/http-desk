//! Exporting a Run's results (`run::run`'s report, `run::export`) as JSON and JUnit
//! XML: every request with its tests and failure reason, no response body, and no
//! Secret value anywhere.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use httpdesk_core::exec::{ClientPool, ExecSettings};
use httpdesk_core::run::{self, export, Cancel, Failure, Outcome, Reason, RequestReport, RunOptions, RunReport};
use httpdesk_core::script::TestResult;
use httpdesk_core::send::{Outgoing, Scripts, SendContext};
use httpdesk_core::session::Session;
use httpdesk_core::*;
use serde_json::{json, Value};
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

const SECRET: &str = "s3cr3t T0ken+/x";

/// A workspace whose `dev` environment has the Secret `token` and the plain `host`.
fn workspace(host: &str) -> tempfile::TempDir {
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("http-client.env.json"), json!({ "dev": { "host": host } }).to_string()).unwrap();
    std::fs::write(ws.path().join("http-client.private.env.json"), json!({ "dev": { "token": SECRET } }).to_string())
        .unwrap();
    ws
}

/// Runs every request of each `(relative path, text)` file in `root`, in order, with `dev`.
async fn run_files(root: &Path, files: &[(&str, &str)]) -> RunReport {
    let mut items = Vec::new();
    for (rel, text) in files {
        let file_path: PathBuf = root.join(rel);
        std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        std::fs::write(&file_path, text).unwrap();
        items.extend(Outgoing::all_in(&file_path, &parse(text)));
    }
    let ctx = SendContext {
        root: Some(root.to_path_buf()),
        environment: Some("dev".into()),
        settings: ExecSettings::default(),
        scripts: Scripts::Run,
        session: Arc::new(Session::default()),
        clients: ClientPool::default(),
    };
    run::run(&ctx, items, RunOptions::default(), &Cancel::default(), |_, _| {}).await
}

async fn ok_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/fail"))
        .respond_with(ResponseTemplate::new(500).set_body_string("BODY-500"))
        .mount(&server)
        .await;
    Mock::given(wiremock::matchers::any())
        .respond_with(ResponseTemplate::new(200).set_body_string("RESPONSE-BODY"))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn the_json_export_lists_every_request_with_its_tests_and_failure_reason() {
    let server = ok_server().await;
    let ws = workspace(&server.uri());
    let pets = "### List pets\n\
                GET {{host}}/pets\n\
                \n\
                > {% client.test(\"Is OK\", function() { client.assert(response.status === 200, \"Expected 200\"); }); %}\n\
                \n\
                ### Create pet\n\
                POST {{host}}/fail\n\
                \n\
                > {% client.test(\"Created\", function() { client.assert(response.status === 201, \"Expected 201\"); }); %}\n";
    let other = "### Unreachable\n\
                 GET http://127.0.0.1:1/down\n\
                 \n\
                 ### Blocked\n\
                 GET {{nowhere}}/x\n";

    let report = run_files(ws.path(), &[("api/pets.http", pets), ("other.http", other)]).await;
    let exported: Value = serde_json::from_str(&export::json(&report.requests)).unwrap();

    let requests = exported["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0]["file"], "api/pets.http");
    assert_eq!(requests[0]["name"], "List pets");
    assert_eq!(requests[0]["method"], "GET");
    assert_eq!(requests[0]["url"], format!("{}/pets", server.uri()));
    assert_eq!(requests[0]["status"], 200);
    assert!(requests[0]["timeMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(requests[0]["tests"], json!([{ "name": "Is OK", "passed": true, "message": null }]));
    assert_eq!(requests[0]["failure"], Value::Null);

    assert_eq!(requests[1]["name"], "Create pet");
    assert_eq!(requests[1]["method"], "POST");
    assert_eq!(requests[1]["status"], 500);
    assert_eq!(requests[1]["tests"], json!([{ "name": "Created", "passed": false, "message": "Expected 201" }]));
    assert_eq!(requests[1]["failure"]["reason"], "test");
    assert!(requests[1]["failure"]["message"].as_str().unwrap().contains("Expected 201"));

    assert_eq!(requests[2]["file"], "other.http");
    assert_eq!(requests[2]["status"], Value::Null);
    assert_eq!(requests[2]["failure"]["reason"], "network");

    assert_eq!(requests[3]["name"], "Blocked");
    assert_eq!(requests[3]["url"], Value::Null, "a blocked request wasn't sent");
    assert_eq!(requests[3]["failure"]["reason"], "blocked");
    assert!(requests[3]["failure"]["message"].as_str().unwrap().contains("nowhere"));
}

/// Whether `text` holds the Secret, in any encoding (its distinctive parts need none).
fn leaks_secret(text: &str) -> bool {
    text.contains("s3cr3t") || text.contains("T0ken")
}

#[tokio::test]
async fn neither_export_holds_a_secret_value_or_a_response_body() {
    let server = ok_server().await;
    let ws = workspace(&server.uri());
    let text = "### In a header\n\
                GET {{host}}/me\n\
                Authorization: Bearer {{token}}\n\
                \n\
                ### In the URL\n\
                GET {{host}}/keys/{{token}}?key={{token}}&other=1\n\
                \n\
                ### In a failure\n\
                GET http://127.0.0.1:1/down?key={{token}}\n\
                \n\
                ### In a test\n\
                < {% request.variables.set(\"t\", request.environment.get(\"token\")) %}\n\
                GET {{host}}/fail\n\
                \n\
                > {% client.test(\"Uses \" + request.variables.get(\"t\"), function() { client.assert(false, \"Sent \" + request.variables.get(\"t\")); }); %}\n";

    let report = run_files(ws.path(), &[("secrets.http", text)]).await;
    let (json, junit) = (export::json(&report.requests), export::junit(&report.requests));

    assert_eq!(report.requests.len(), 4);
    for (format, exported) in [("JSON", &json), ("JUnit", &junit)] {
        assert!(!leaks_secret(exported), "{format} holds the Secret:\n{exported}");
        assert!(!exported.contains("RESPONSE-BODY") && !exported.contains("BODY-500"), "{format} holds a body");
        assert!(exported.contains("••••••••"), "{format} shows where the Secret was masked");
    }
    let requests: Value = serde_json::from_str(&json).unwrap();
    let url = requests["requests"][1]["url"].as_str().unwrap();
    assert_eq!(url, format!("{}/keys/••••••••?key=••••••••&other=1", server.uri()), "the rest of the URL as sent");
    assert_eq!(requests["requests"][2]["failure"]["reason"], "network");
}

fn report(file: Option<&str>, name: &str, outcome: Outcome) -> RequestReport {
    let sent = matches!(outcome, Outcome::Passed | Outcome::Failed);
    RequestReport {
        file: file.map(str::to_string),
        name: name.into(),
        method: "GET".into(),
        url: sent.then(|| "https://api.example.com/pets?a=1&b=<2>".into()),
        status: sent.then_some(200),
        time_ms: sent.then_some(12.3456),
        outcome,
        failure: None,
        tests: Vec::new(),
    }
}

fn test(name: &str, failure: Option<&str>) -> TestResult {
    TestResult { name: name.into(), passed: failure.is_none(), message: failure.map(str::to_string) }
}

/// One of each outcome and failure reason, across two files and none, with
/// characters XML must escape or can't hold.
fn every_kind_of_result() -> Vec<RequestReport> {
    let mut passed = report(Some("api/pets.http"), "List \"pets\" & <more>", Outcome::Passed);
    passed.tests = vec![test("Is OK", None), test("Has pets", None)];
    let mut failed_test = report(Some("api/pets.http"), "Create pet", Outcome::Failed);
    failed_test.tests =
        vec![test("Is OK", None), test("Created", Some("Expected 201\nbut got 200")), test("Id", Some("No id"))];
    failed_test.failure = Some(Failure { reason: Reason::Test, message: "\"Created\": Expected 201".into() });
    let mut script = report(Some("api/pets.http"), "Get pet", Outcome::Failed);
    script.tests = vec![test("Response handler", Some("ReferenceError: x is not defined\u{1}"))];
    script.failure = Some(Failure { reason: Reason::Script, message: "ReferenceError".into() });
    let mut network = report(Some("other.http"), "Down", Outcome::Failed);
    (network.url, network.status, network.time_ms) = (None, None, None);
    network.failure = Some(Failure { reason: Reason::Network, message: "Connection refused".into() });
    let mut blocked = report(None, "Unsaved", Outcome::Failed);
    (blocked.url, blocked.status, blocked.time_ms) = (None, None, None);
    blocked.failure =
        Some(Failure { reason: Reason::Blocked, message: "The URL's host uses undefined variables: nowhere.".into() });
    vec![
        passed,
        failed_test,
        report(Some("other.http"), "Stopped", Outcome::Cancelled),
        script,
        network,
        blocked,
        report(Some("other.http"), "Never reached", Outcome::NotRun),
    ]
}

#[test]
fn the_junit_export_is_valid_against_the_common_junit_schema() {
    let xml = export::junit(&every_kind_of_result());

    if let Err(e) = xsd::validate(&xml) {
        panic!("{e}\n{xml}");
    }
}

#[test]
fn the_schema_check_rejects_what_the_schema_does() {
    for bad in [
        "<testsuites><testcase name=\"a\"/></testsuites>",
        "<testsuites><testsuite name=\"f\" tests=\"1\" failures=\"0\"/></testsuites>",
        "<testsuites><testsuite name=\"f\" tests=\"1\" failures=\"0\" errors=\"0\" time=\"0.0001\"/></testsuites>",
        "<testsuites><testsuite name=\"f\" tests=\"1\" failures=\"0\" errors=\"0\"><testcase name=\"a\"><properties/></testcase></testsuite></testsuites>",
        "<testsuites><testsuite name=\"f\" tests=\"1\" failures=\"0\" errors=\"0\"><testcase name=\"a\">text</testcase></testsuite></testsuites>",
        "<testsuites><testsuite name=\"f\" tests=\"1\" failures=\"0\" errors=\"0\"><testcase name=\"a\" status=\"x\"/></testsuite></testsuites>",
    ] {
        assert!(xsd::validate(bad).is_err(), "{bad}");
    }
}

#[test]
fn the_junit_export_has_a_suite_per_file_a_case_per_request_and_each_failure_with_its_reason() {
    let xml = export::junit(&every_kind_of_result());
    let package = sxd_document::parser::parse(&xml).unwrap();
    let doc = package.as_document();
    let read = |path: &str| {
        let xpath = sxd_xpath::Factory::new().build(path).unwrap().unwrap();
        xpath.evaluate(&sxd_xpath::Context::new(), doc.root()).unwrap().into_string()
    };
    let count = |path: &str| read(&format!("count({path})"));

    assert_eq!(count("/testsuites/testsuite"), "3");
    assert_eq!(read("/testsuites/testsuite[1]/@name"), "api/pets.http");
    assert_eq!(read("/testsuites/testsuite[2]/@name"), "other.http");
    assert_eq!(count("//testcase"), "7");
    assert_eq!(read("/testsuites/@tests"), "7");
    assert_eq!(read("/testsuites/@failures"), "4");
    assert_eq!(read("/testsuites/testsuite[1]/@failures"), "2");
    assert_eq!(read("/testsuites/testsuite[2]/@skipped"), "2");

    let case = |name: &str| format!("//testcase[@name='{name}']");
    assert_eq!(read(&format!("{}/@classname", case("Create pet"))), "api/pets.http");
    assert_eq!(read(&format!("{}/@time", case("Create pet"))), "0.012");
    // Each failed client.test is its own failure; the passed ones are listed in its output.
    assert_eq!(count(&format!("{}/failure[@type='test']", case("Create pet"))), "2");
    assert_eq!(read(&format!("{}/failure[1]/@message", case("Create pet"))), "\"Created\": Expected 201\nbut got 200");
    let out = read(&format!("{}/system-out", case("Create pet")));
    assert!(out.contains("GET https://api.example.com/pets?a=1&b=<2> → 200"), "{out}");
    assert!(out.contains("✓ Is OK") && out.contains("✗ Id: No id"), "{out}");
    assert_eq!(read(&format!("{}/failure/@type", case("Get pet"))), "script");
    assert_eq!(read(&format!("{}/failure/@type", case("Down"))), "network");
    assert_eq!(read(&format!("{}/failure/@message", case("Down"))), "Connection refused");
    assert_eq!(read(&format!("{}/failure/@type", case("Unsaved"))), "blocked");
    assert_eq!(count(&format!("{}/skipped", case("Stopped"))), "1");
    assert_eq!(count(&format!("{}/skipped", case("Never reached"))), "1");
    assert_eq!(count(&format!("{}/*", case("List \"pets\" & <more>"))), "1", "a pass has only its output");
}

/// Validation against `tests/fixtures/junit-10.xsd` (vendored), implementing the part of
/// XML Schema it uses: global elements, element refs in sequences and choices, named
/// and inline complex types (mixed or not), `xs:string` elements, attributes with
/// `use="required"`, and the `SUREFIRE_TIME` pattern. Child order isn't checked: in
/// this schema only `rerunType`, which the export never writes, orders its children.
mod xsd {
    use std::collections::HashMap;

    use sxd_document::dom::{ChildOfElement, Element};

    const SCHEMA: &str = include_str!("fixtures/junit-10.xsd");

    /// What the schema allows an element to be.
    #[derive(Default)]
    struct Rule {
        children: Vec<String>,
        /// Attribute name → (required, type).
        attributes: HashMap<String, (bool, String)>,
        text: bool,
    }

    fn xs_children<'d>(e: Element<'d>, local: &'static str) -> impl Iterator<Item = Element<'d>> {
        e.children().into_iter().filter_map(|c| c.element()).filter(move |c| c.name().local_part() == local)
    }

    fn attr<'d>(e: Element<'d>, name: &str) -> Option<&'d str> {
        e.attribute_value(name)
    }

    fn complex_rule(t: Element) -> Rule {
        let mut rule = Rule { text: attr(t, "mixed") == Some("true"), ..Default::default() };
        // Every element a sequence or choice (however nested) lists.
        let mut stack = vec![t];
        while let Some(e) = stack.pop() {
            for child in e.children().into_iter().filter_map(|c| c.element()) {
                match child.name().local_part() {
                    "element" => rule.children.push(attr(child, "ref").or(attr(child, "name")).unwrap().to_string()),
                    "sequence" | "choice" => stack.push(child),
                    _ => {}
                }
            }
        }
        for a in xs_children(t, "attribute") {
            let required = attr(a, "use") == Some("required");
            rule.attributes.insert(attr(a, "name").unwrap().into(), (required, attr(a, "type").unwrap().into()));
        }
        rule
    }

    fn rules(schema: Element) -> HashMap<String, Rule> {
        let types: HashMap<&str, Element> =
            xs_children(schema, "complexType").map(|t| (attr(t, "name").unwrap(), t)).collect();
        xs_children(schema, "element")
            .map(|e| {
                let rule = match attr(e, "type") {
                    Some("xs:string") => Rule { text: true, ..Default::default() },
                    Some(named) => complex_rule(types[named]),
                    None => complex_rule(xs_children(e, "complexType").next().unwrap()),
                };
                (attr(e, "name").unwrap().to_string(), rule)
            })
            .collect()
    }

    /// `SUREFIRE_TIME`: digits (commas between thousands allowed), then at most three decimals.
    fn surefire_time(v: &str) -> bool {
        let (whole, decimals) = v.split_once('.').unwrap_or((v, ""));
        whole.chars().all(|c| c.is_ascii_digit() || c == ',')
            && decimals.len() <= 3
            && decimals.chars().all(|c| c.is_ascii_digit())
    }

    fn check(e: Element, rules: &HashMap<String, Rule>, path: &str) -> Result<(), String> {
        let name = e.name().local_part();
        let path = format!("{path}/{name}");
        let rule = rules.get(name).ok_or_else(|| format!("{path}: no such element"))?;
        for a in e.attributes() {
            let a_name = a.name().local_part();
            let (_, kind) = rule.attributes.get(a_name).ok_or_else(|| format!("{path}: no attribute {a_name}"))?;
            if kind == "SUREFIRE_TIME" && !surefire_time(a.value()) {
                return Err(format!("{path}/@{a_name}: \"{}\" isn't a SUREFIRE_TIME", a.value()));
            }
        }
        for (a_name, (required, _)) in &rule.attributes {
            if *required && e.attribute(a_name.as_str()).is_none() {
                return Err(format!("{path}: missing required attribute {a_name}"));
            }
        }
        for child in e.children() {
            match child {
                ChildOfElement::Element(c) => {
                    if !rule.children.iter().any(|n| n == c.name().local_part()) {
                        return Err(format!("{path}: {} isn't allowed here", c.name().local_part()));
                    }
                    check(c, rules, &path)?;
                }
                ChildOfElement::Text(t) if !rule.text && !t.text().trim().is_empty() => {
                    return Err(format!("{path}: text isn't allowed here"));
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn validate(xml: &str) -> Result<(), String> {
        let schema = sxd_document::parser::parse(SCHEMA).unwrap();
        let schema = schema.as_document();
        let schema_root = schema.root().children().into_iter().find_map(|c| c.element()).unwrap();
        let rules = rules(schema_root);
        let package = sxd_document::parser::parse(xml).map_err(|e| format!("not well-formed XML: {e}"))?;
        let doc = package.as_document();
        let root = doc.root().children().into_iter().find_map(|c| c.element()).ok_or("no root element")?;
        check(root, &rules, "")
    }
}
