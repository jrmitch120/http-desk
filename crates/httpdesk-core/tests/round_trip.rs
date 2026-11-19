//! The lossless contract editing the text relies on: any text, parsed and
//! re-rendered, is byte-identical.

use std::path::{Path, PathBuf};

use httpdesk_core::*;

/// Every `.http` file in the repository (git-ignored paths such as `target/` skipped).
fn fixture_files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files: Vec<PathBuf> = ignore::Walk::new(&root)
        .filter_map(Result::ok)
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "http"))
        .collect();
    files.sort();
    assert!(files.len() >= 6, "found only {files:?}");
    files
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn every_fixture_file_saves_back_byte_for_byte() {
    for path in fixture_files() {
        let text = read(&path);
        assert_eq!(serialize(&parse(&text)), text, "{}", path.display());
    }
}

#[test]
fn every_fixture_file_parsed_with_problems_is_the_plain_parse() {
    for path in fixture_files() {
        let text = read(&path);
        assert_eq!(parse_with_problems(&text).file, parse(&text), "{}", path.display());
    }
}

#[test]
fn well_formed_fixture_files_have_no_problems() {
    for path in fixture_files().iter().filter(|p| !p.parent().is_some_and(|d| d.ends_with("problems"))) {
        assert_eq!(parse_with_problems(&read(path)).problems, [], "{}", path.display());
    }
}

// ---------------------------------------------------------------- any text

use proptest::prelude::*;

/// A line of `.http`-shaped text: well-formed pieces, broken request lines,
/// stray headers, unclosed `{% %}` blocks, `#~` lines, and arbitrary text.
fn line() -> impl Strategy<Value = String> {
    let shaped = prop::sample::select(vec![
        "###",
        "### Named",
        "#### four",
        "GET https://x/{{a}}?q=1&b",
        "POST {{host}}/p HTTP/1.1",
        "get https://lower",
        "FOO",
        "not a request line",
        "GET https://x has spaces HTTP/1.1",
        "    ?x=1",
        "  &y=2",
        "Accept: */*",
        "Content-Type: application/json",
        "Content-Type: multipart/form-data; boundary=b",
        "Authorization: Basic dXNlcjpwYXNz",
        "Authorization: Bearer t",
        "X-API-Key: k",
        "Name : spaced",
        "# comment",
        "// comment",
        "#",
        "# @name foo",
        "// @no-redirect",
        "# @nmae typo",
        "#@timeout 5",
        "#   @indented",
        "# @httpdesk-disabled query, headers, other",
        "# @httpdesk-auth apikey header X-API-Key",
        "# @httpdesk-auth apikey query k",
        "# @httpdesk-auth oauth2",
        "# @param q: doc",
        "# @header Accept: doc",
        "# @prompt password",
        "#~ X-Off: y",
        "#~~ X-Off: y",
        "#~ &q=1",
        "#~ ?q=2",
        "#~| body",
        "#~|",
        "#~= part",
        "#~ not a header",
        "",
        " ",
        "\t",
        "@v = 1",
        "@bad name = x",
        "@ = nothing",
        "< {%",
        "< {% request.variables.set('a', 1) %}",
        "< ./pre.js",
        "> {%",
        "> {% client.log(1) %}",
        "> ./after.js",
        "%}",
        ">> out.json",
        ">>! out.json",
        " > indented",
        "< ./file.json",
        "<@ ./file.json",
        "<?xml version=\"1.0\"?>",
        "{",
        "  \"a\": 1",
        "}",
        "--b",
        "Content-Disposition: form-data; name=\"f\"",
        "--b--",
        "a=1&b=2",
        "\u{FEFF}",
        "é ✓ 🦀",
    ])
    .prop_map(str::to_string);
    prop_oneof![4 => shaped, 1 => "\\PC{0,12}", 1 => "[#~@<>{}%: &?=|\t\r]{0,6}"]
}

/// Line endings: all LF, all CRLF, or mixed per line (including a stray CR).
fn endings(n: usize) -> impl Strategy<Value = Vec<&'static str>> {
    prop_oneof![
        Just(vec!["\n"; n]),
        Just(vec!["\r\n"; n]),
        prop::collection::vec(prop::sample::select(vec!["\n", "\r\n", "\r\r\n", "\r"]), n),
    ]
}

/// Joins `lines` with `endings`, with an optional BOM and final line ending.
fn join(lines: &[String], endings: &[&str], bom: bool, final_ending: bool) -> String {
    let mut text = String::from(if bom { "\u{FEFF}" } else { "" });
    for (i, (l, e)) in lines.iter().zip(endings).enumerate() {
        text.push_str(l);
        if i + 1 < lines.len() || final_ending {
            text.push_str(e);
        }
    }
    text
}

/// `.http`-shaped text, sometimes with a BOM and without a final line ending.
fn http_text() -> impl Strategy<Value = String> {
    prop::collection::vec(line(), 0..24)
        .prop_flat_map(|lines| {
            let n = lines.len();
            (Just(lines), endings(n), any::<bool>(), any::<bool>())
        })
        .prop_map(|(lines, endings, bom, final_ending)| join(&lines, &endings, bom, final_ending))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn any_text_saves_back_byte_for_byte(text in http_text()) {
        prop_assert_eq!(serialize(&parse(&text)), text);
    }

    #[test]
    fn a_single_requests_text_renders_back_byte_for_byte(text in request_text_strategy()) {
        let parsed = parse_request(&text);
        if let Some(req) = parsed.request {
            prop_assert_eq!(request_source(&req), text);
        }
    }
}

/// A single request's text: like [`http_text`], with no `###` except, sometimes,
/// on the first line, and a request line somewhere.
fn request_text_strategy() -> impl Strategy<Value = String> {
    let body = prop::collection::vec(line().prop_filter("no separator", |l| !l.starts_with("###")), 0..16);
    (prop::option::of(prop::sample::select(vec!["###", "### Named"])), body, "(GET|post|FOO) [a-z/:{} ]{1,12}")
        .prop_flat_map(|(separator, mut lines, request_line)| {
            let at = lines.len() / 2;
            lines.insert(at, request_line);
            lines.splice(0..0, separator.map(str::to_string));
            let n = lines.len();
            (Just(lines), endings(n), any::<bool>(), any::<bool>())
        })
        .prop_map(|(lines, endings, bom, final_ending)| join(&lines, &endings, bom, final_ending))
}

#[test]
fn a_single_request_reads_as_the_first_request_of_a_file() {
    let text = "### Get one\r\nGET https://x?a=1\r\nAccept: */*\r\n";
    let req = parse_request(text).request.unwrap();
    let in_file = parse(text).requests.remove(0);
    assert_eq!(Request { raw: None, ..req.clone() }, Request { raw: None, ..in_file });
    assert_eq!(request_source(&req), text);

    // Text before the request is kept with it.
    let text = "\u{FEFF}# notes\n@v = 1\n\n### Get one\nGET https://x\n";
    let req = parse_request(text).request.unwrap();
    assert_eq!(req.leading, "\u{FEFF}# notes\n@v = 1\n\n");
    assert_eq!(request_source(&req), text);

    assert_eq!(parse_request("# only a comment\n").request, None);
}
