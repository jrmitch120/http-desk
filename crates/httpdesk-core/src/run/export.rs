//! A Run's results as files to attach to a CI ticket: JSON, and JUnit XML that the
//! common JUnit schema (Jenkins' `junit-10.xsd`) accepts. Both read only the
//! [`RequestReport`]s, which hold no response body and no Secret value.

use serde_json::json;

use super::report::{Outcome, RequestReport};

/// The requests as JSON: a summary, then each request in run order.
pub fn json(requests: &[RequestReport]) -> String {
    let count = |o: Outcome| requests.iter().filter(|r| r.outcome == o).count();
    let doc = json!({
        "summary": {
            "requests": requests.len(),
            "passed": count(Outcome::Passed),
            "failed": count(Outcome::Failed),
            "didNotRun": count(Outcome::Cancelled) + count(Outcome::NotRun),
        },
        "requests": requests,
    });
    let mut text = serde_json::to_string_pretty(&doc).expect("a report serializes");
    text.push('\n');
    text
}

/// The requests as JUnit XML: a test suite per file (in the order the run reached
/// them) and a test case per request. A failure is a `<failure>` of its reason's
/// type, one per failed test; a request that didn't run is `<skipped>`. Each test
/// case's `<system-out>` lists what was sent and every test, passed or not.
pub fn junit(requests: &[RequestReport]) -> String {
    let mut suites: Vec<(&str, Vec<&RequestReport>)> = Vec::new();
    for r in requests {
        let file = r.file.as_deref().unwrap_or("Requests in no file");
        match suites.iter_mut().find(|(f, _)| *f == file) {
            Some((_, cases)) => cases.push(r),
            None => suites.push((file, vec![r])),
        }
    }
    let failed = |cases: &[&RequestReport]| cases.iter().filter(|r| r.outcome == Outcome::Failed).count();
    let skipped = |cases: &[&RequestReport]| {
        cases.iter().filter(|r| matches!(r.outcome, Outcome::Cancelled | Outcome::NotRun)).count()
    };
    let time = |cases: &[&RequestReport]| seconds(cases.iter().filter_map(|r| r.time_ms).sum());

    let all: Vec<&RequestReport> = requests.iter().collect();
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str(&format!(
        "<testsuites name=\"http-desk run\" tests=\"{}\" failures=\"{}\" errors=\"0\" time=\"{}\">\n",
        all.len(),
        failed(&all),
        time(&all)
    ));
    for (file, cases) in &suites {
        xml.push_str(&format!(
            "  <testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" errors=\"0\" skipped=\"{}\" time=\"{}\">\n",
            attr(file),
            cases.len(),
            failed(cases),
            skipped(cases),
            time(cases)
        ));
        for r in cases {
            test_case(&mut xml, file, r);
        }
        xml.push_str("  </testsuite>\n");
    }
    xml.push_str("</testsuites>\n");
    xml
}

fn test_case(xml: &mut String, file: &str, r: &RequestReport) {
    let time = r.time_ms.map(|ms| format!(" time=\"{}\"", seconds(ms))).unwrap_or_default();
    xml.push_str(&format!("    <testcase name=\"{}\" classname=\"{}\"{time}>\n", attr(&r.name), attr(file)));
    let failure = |xml: &mut String, kind: &str, message: &str| {
        xml.push_str(&format!(
            "      <failure type=\"{kind}\" message=\"{}\">{}</failure>\n",
            attr(message),
            text(message)
        ));
    };
    match (&r.outcome, &r.failure) {
        (Outcome::Failed, _) if r.tests.iter().any(|t| !t.passed) => {
            for t in r.tests.iter().filter(|t| !t.passed) {
                let kind = if t.script_error { "script" } else { "test" };
                failure(xml, kind, &super::report::test_failure(t));
            }
        }
        (Outcome::Failed, Some(f)) => failure(xml, f.reason.as_str(), &f.message),
        (Outcome::Cancelled, _) => {
            xml.push_str("      <skipped message=\"The run was stopped while it was being sent\"/>\n")
        }
        (Outcome::NotRun, _) => xml.push_str("      <skipped message=\"The run was stopped before it\"/>\n"),
        _ => {}
    }
    let mut out = Vec::new();
    if let Some(url) = &r.url {
        let status = r.status.map(|s| format!(" → {s}")).unwrap_or_default();
        out.push(format!("{} {url}{status}", r.method));
    }
    for t in &r.tests {
        out.push(match (t.passed, &t.message) {
            (true, _) => format!("✓ {}", t.name),
            (false, Some(m)) => format!("✗ {}: {m}", t.name),
            (false, None) => format!("✗ {}", t.name),
        });
    }
    if !out.is_empty() {
        xml.push_str(&format!("      <system-out>{}</system-out>\n", text(&out.join("\n"))));
    }
    xml.push_str("    </testcase>\n");
}

/// Milliseconds as JUnit's seconds, to the millisecond.
fn seconds(ms: f64) -> String {
    format!("{:.3}", ms.max(0.0) / 1000.0)
}

/// `s` as XML character data. Characters XML 1.0 can't hold become U+FFFD.
fn text(s: &str) -> String {
    escape(s, false)
}

/// `s` as a double-quoted XML attribute value, line breaks and tabs kept.
fn attr(s: &str) -> String {
    escape(s, true)
}

fn escape(s: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            '\n' if attribute => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            '\t' if attribute => out.push_str("&#9;"),
            '\t' | '\n' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => out.push('\u{FFFD}'),
            c => out.push(c),
        }
    }
    out
}
