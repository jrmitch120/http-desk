//! Which lines of a `.http` text behave differently in JetBrains (Rider) and VS Code
//! (REST Client). [`TABLE`] lists each construct HttpDesk reads, how the two editors
//! treat it and the documentation that says so: it is the one place to change when
//! either editor adds support. [`portability`] finds the constructs in a text.
//!
//! It reads lines with the parser's own rules (blocks, preamble, header area, body,
//! response handler). Only text, so the dev mock runs it too (httpdesk-text-wasm).

use serde::{Serialize, Serializer};

use crate::model::{BodyMode, Request};
use crate::parser::{self, BOM, DISABLED_MARKER};
use crate::vars::{segments, split_reference, Segment};

/// How the two editors treat a construct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Support {
    /// Both editors read it the same way.
    Portable,
    /// JetBrains (Rider) reads it; VS Code doesn't.
    JetbrainsOnly,
    /// VS Code (REST Client) reads it; Rider doesn't.
    VscodeOnly,
    /// HttpDesk's own, written as a comment: both editors ignore it.
    HttpdeskOnly,
}

/// One row of [`TABLE`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Construct {
    NameDirective,
    NoRedirectDirective,
    NoCookieJarDirective,
    NoLogDirective,
    NoAutoEncodingDirective,
    TimeoutDirective,
    ConnectionTimeoutDirective,
    UseOsCredentialsDirective,
    NoteDirective,
    PromptDirective,
    HttpdeskDisabledDirective,
    HttpdeskAuthDirective,
    DocDirective,
    DisabledLine,
    ResponseHandler,
    PreRequestScript,
    ResponseRedirect,
    FileVariable,
    RequestVariable,
    Timestamp,
    JetbrainsDynamicVariable,
    RandomInt,
    VscodeDynamicVariable,
    VscodeSignInVariable,
    ExampleServer,
    RandomIntRange,
    TimestampOffset,
    GraphqlRequestTypeHeader,
    GraphqlMethod,
    BodyFile,
    BodyFileWithVariables,
    BodyFileLine,
}

impl Construct {
    /// Its name in JSON and in test fixtures (`fixtures/portability/<id>.http`).
    pub fn id(self) -> &'static str {
        row(self).id
    }

    pub fn support(self) -> Support {
        row(self).support
    }
}

impl Serialize for Construct {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.id())
    }
}

/// A construct, how the editors treat it, and where each editor's documentation
/// (or, where the docs are silent, its source or the research that tested it) says so.
#[derive(Debug)]
pub struct Row {
    pub construct: Construct,
    pub id: &'static str,
    pub support: Support,
    /// The construct as written.
    pub label: &'static str,
    /// Shown on hover over the line's marker: what the editor the line behaves
    /// differently in does with it, naming only that editor (a note is for one
    /// editor, and shows only while it's turned on, #182). HttpDesk-only lines name
    /// neither; portable ones, which are never marked, say what both do.
    pub hover: &'static str,
    pub jetbrains: &'static [&'static str],
    pub vscode: &'static [&'static str],
}

macro_rules! jb {
    ($page:literal) => {
        concat!("https://www.jetbrains.com/help/idea/", $page)
    };
}
/// REST Client at the commit docs/research/http-comment-compat.md read (0.26.0).
macro_rules! vsc {
    ($path:literal) => {
        concat!("https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/", $path)
    };
}
/// Our research into each editor, where the docs are silent: Q1/Q2 (comments and
/// tags, with JetBrains' plugin and REST Client's source), Q7 (each editor's chaining
/// syntax in the other) and Appendix B (HttpDesk's lines run through JetBrains' CLI).
const RESEARCH: &str = "docs/research/http-comment-compat.md";

const VSC_SETTINGS: &str = vsc!("README.md#per-request-settings");
const VSC_SYSTEM: &str = vsc!("README.md#system-variables");
const VSC_SYSTEM_SRC: &str = vsc!("src/utils/httpVariableProviders/systemVariableProvider.ts");
const VSC_BODY: &str = vsc!("README.md#request-body");
const VSC_COMMENTS: &str = vsc!("src/utils/selector.ts");
const JB_COMMENTS: &str = jb!("exploring-http-syntax.html#comments-in-http-requests");
const JB_DYNAMIC: &str = jb!("http-client-variables.html#dynamic-variables");

/// Every construct HttpDesk reads that the editors might treat differently.
pub static TABLE: &[Row] = &[
    // ---- `# @` directives above the request line ----
    Row {
        construct: Construct::NameDirective,
        id: "name-directive",
        support: Support::Portable,
        label: "# @name",
        hover: "Both editors name the request",
        jetbrains: &[jb!("exploring-http-syntax.html#http_request_names")],
        vscode: &[vsc!("README.md#request-variables")],
    },
    Row {
        construct: Construct::NoRedirectDirective,
        id: "no-redirect-directive",
        support: Support::Portable,
        label: "# @no-redirect",
        hover: "Neither editor follows redirects for this request",
        jetbrains: &[jb!("exploring-http-syntax.html#enable-disable-redirects")],
        vscode: &[VSC_SETTINGS],
    },
    Row {
        construct: Construct::NoCookieJarDirective,
        id: "no-cookie-jar-directive",
        support: Support::Portable,
        label: "# @no-cookie-jar",
        hover: "Neither editor saves this request's cookies",
        jetbrains: &[jb!("exploring-http-syntax.html#enable-disable-saving-cookies")],
        vscode: &[VSC_SETTINGS],
    },
    Row {
        construct: Construct::NoLogDirective,
        id: "no-log-directive",
        support: Support::JetbrainsOnly,
        label: "# @no-log",
        hover: "VS Code ignores @no-log and keeps this request in its history",
        jetbrains: &[jb!("exploring-http-syntax.html#enable-disable-saving-request")],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::NoAutoEncodingDirective,
        id: "no-auto-encoding-directive",
        support: Support::JetbrainsOnly,
        label: "# @no-auto-encoding",
        hover: "VS Code ignores @no-auto-encoding",
        jetbrains: &[jb!("exploring-http-syntax.html#disabling-encoding")],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::TimeoutDirective,
        id: "timeout-directive",
        support: Support::JetbrainsOnly,
        label: "# @timeout",
        hover: "VS Code ignores @timeout",
        jetbrains: &[jb!("exploring-http-syntax.html#specify-request-timeouts")],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::ConnectionTimeoutDirective,
        id: "connection-timeout-directive",
        support: Support::JetbrainsOnly,
        label: "# @connection-timeout",
        hover: "VS Code ignores @connection-timeout",
        jetbrains: &[jb!("exploring-http-syntax.html#specify-request-timeouts")],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::UseOsCredentialsDirective,
        id: "use-os-credentials-directive",
        support: Support::JetbrainsOnly,
        label: "# @use-os-credentials",
        // Not on JetBrains' help pages: the research found it in the plugin's tag list (Q2).
        hover: "VS Code ignores @use-os-credentials",
        jetbrains: &[RESEARCH],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::NoteDirective,
        id: "note-directive",
        support: Support::VscodeOnly,
        label: "# @note",
        hover: "Rider ignores @note and sends without asking for confirmation",
        jetbrains: &[jb!("exploring-http-syntax.html#http_request_names"), RESEARCH],
        vscode: &[VSC_SETTINGS],
    },
    Row {
        construct: Construct::PromptDirective,
        id: "prompt-directive",
        support: Support::VscodeOnly,
        label: "# @prompt",
        hover: "Rider ignores @prompt and sends the {{variable}} as written",
        jetbrains: &[jb!("http-client-variables.html#variable-types"), RESEARCH],
        vscode: &[vsc!("README.md#prompt-variables")],
    },
    Row {
        construct: Construct::HttpdeskDisabledDirective,
        id: "httpdesk-disabled-directive",
        support: Support::HttpdeskOnly,
        label: "# @httpdesk-disabled",
        hover: "Only HttpDesk reads this line (sections turned off)",
        jetbrains: &[JB_COMMENTS, RESEARCH],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::HttpdeskAuthDirective,
        id: "httpdesk-auth-directive",
        support: Support::HttpdeskOnly,
        label: "# @httpdesk-auth",
        hover: "Only HttpDesk reads this line (API key auth); other editors send the key as written",
        jetbrains: &[JB_COMMENTS, RESEARCH],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::DocDirective,
        id: "doc-directive",
        support: Support::HttpdeskOnly,
        label: "# @param, # @header",
        hover: "Only HttpDesk reads this line (a description)",
        jetbrains: &[JB_COMMENTS, RESEARCH],
        vscode: &[VSC_SETTINGS, RESEARCH],
    },
    Row {
        construct: Construct::DisabledLine,
        id: "disabled-line",
        support: Support::HttpdeskOnly,
        label: "#~",
        hover: "Turned off in HttpDesk; other editors ignore this line too",
        jetbrains: &[JB_COMMENTS, RESEARCH],
        vscode: &[VSC_COMMENTS, RESEARCH],
    },
    // ---- scripts and redirects ----
    Row {
        construct: Construct::ResponseHandler,
        id: "response-handler",
        support: Support::JetbrainsOnly,
        label: "> {% %}",
        hover: "VS Code ignores this response handler and sends its lines as body text",
        jetbrains: &[jb!("http-client-in-product-code-editor.html#insert-the-script")],
        vscode: &[VSC_BODY, RESEARCH],
    },
    Row {
        construct: Construct::PreRequestScript,
        id: "pre-request-script",
        support: Support::JetbrainsOnly,
        label: "< {% %}",
        hover: "VS Code ignores this pre-request script and reads it as the request line, so the request breaks",
        jetbrains: &[jb!("http-client-in-product-code-editor.html#insert-the-pre-request-script")],
        vscode: &[vsc!("README.md#request-line"), RESEARCH],
    },
    Row {
        construct: Construct::ResponseRedirect,
        id: "response-redirect",
        support: Support::JetbrainsOnly,
        label: ">>",
        hover: "VS Code ignores this redirect and sends the line as body text",
        jetbrains: &[jb!("exploring-http-syntax.html#response-redirect")],
        vscode: &[VSC_BODY, RESEARCH],
    },
    // ---- variables ----
    Row {
        construct: Construct::FileVariable,
        id: "file-variable",
        support: Support::Portable,
        label: "@name = value",
        hover: "Both editors read this variable",
        jetbrains: &[jb!("http-client-variables.html#in-place-variables")],
        vscode: &[vsc!("README.md#file-variables")],
    },
    Row {
        construct: Construct::RequestVariable,
        id: "request-variable",
        support: Support::VscodeOnly,
        label: "{{name.response…}}",
        hover: "Rider refuses to send a request containing this",
        jetbrains: &["https://youtrack.jetbrains.com/issue/IJPL-253135", RESEARCH],
        vscode: &[vsc!("README.md#request-variables")],
    },
    Row {
        construct: Construct::Timestamp,
        id: "timestamp",
        support: Support::Portable,
        label: "{{$timestamp}}",
        hover: "Both editors give the current Unix time",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM],
    },
    Row {
        construct: Construct::JetbrainsDynamicVariable,
        id: "jetbrains-dynamic-variable",
        support: Support::JetbrainsOnly,
        label: "{{$uuid}}, {{$random.*}}, {{$isoTimestamp}}, {{$env.*}}",
        hover: "VS Code doesn't know this dynamic variable and sends it as written",
        jetbrains: &[
            JB_DYNAMIC,
            jb!("http-client-variables.html#random-variables"),
            jb!("http-client-variables.html#system-environment-variables"),
        ],
        vscode: &[VSC_SYSTEM, VSC_SYSTEM_SRC],
    },
    Row {
        construct: Construct::RandomInt,
        id: "random-int",
        support: Support::JetbrainsOnly,
        label: "{{$randomInt}}",
        hover: "VS Code needs {{$randomInt min max}} and sends this as written",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM, VSC_SYSTEM_SRC],
    },
    Row {
        construct: Construct::VscodeDynamicVariable,
        id: "vscode-dynamic-variable",
        support: Support::VscodeOnly,
        label: "{{$guid}}, {{$datetime}}, {{$localDatetime}}, {{$processEnv}}, {{$dotenv}}",
        hover: "Rider doesn't know this dynamic variable",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM],
    },
    Row {
        construct: Construct::VscodeSignInVariable,
        id: "vscode-sign-in-variable",
        support: Support::VscodeOnly,
        label: "{{$aadToken}}, {{$aadV2Token}}, {{$oidcAccessToken}}",
        hover: "Rider doesn't know this sign-in variable and sends it as written",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM, VSC_SYSTEM_SRC],
    },
    Row {
        construct: Construct::ExampleServer,
        id: "example-server",
        support: Support::JetbrainsOnly,
        label: "{{$exampleServer}}",
        hover: "VS Code doesn't know this variable and sends it as written",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM, VSC_SYSTEM_SRC],
    },
    Row {
        construct: Construct::RandomIntRange,
        id: "random-int-range",
        support: Support::VscodeOnly,
        label: "{{$randomInt min max}}",
        hover: "Rider's $randomInt takes no range (it has $random.integer(min, max))",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM],
    },
    Row {
        construct: Construct::TimestampOffset,
        id: "timestamp-offset",
        support: Support::VscodeOnly,
        label: "{{$timestamp offset unit}}",
        hover: "Rider's $timestamp takes no offset",
        jetbrains: &[JB_DYNAMIC],
        vscode: &[VSC_SYSTEM],
    },
    // ---- request types ----
    Row {
        construct: Construct::GraphqlRequestTypeHeader,
        id: "graphql-request-type-header",
        support: Support::VscodeOnly,
        label: "X-REQUEST-TYPE: GraphQL",
        hover: "Rider sends this header and the body as written (it uses the GRAPHQL method)",
        jetbrains: &[jb!("http-client-in-product-code-editor.html#graphql")],
        vscode: &[vsc!("README.md#making-graphql-request")],
    },
    Row {
        construct: Construct::GraphqlMethod,
        id: "graphql-method",
        support: Support::JetbrainsOnly,
        label: "GRAPHQL",
        hover: "VS Code has no GRAPHQL method (it uses an X-REQUEST-TYPE: GraphQL header)",
        jetbrains: &[jb!("http-client-in-product-code-editor.html#graphql")],
        vscode: &[vsc!("README.md#making-graphql-request")],
    },
    // ---- bodies from files ----
    Row {
        construct: Construct::BodyFile,
        id: "body-file",
        support: Support::Portable,
        label: "< file",
        hover: "Both editors send this file's content; Rider also fills in {{variables}} written in the file",
        jetbrains: &[jb!("exploring-http-syntax.html#provide-request-body")],
        vscode: &[VSC_BODY],
    },
    Row {
        construct: Construct::BodyFileWithVariables,
        id: "body-file-with-variables",
        support: Support::VscodeOnly,
        label: "<@ file",
        hover: "Rider sends this line as text, not the file's content",
        jetbrains: &[jb!("exploring-http-syntax.html#provide-request-body")],
        vscode: &[VSC_BODY],
    },
    Row {
        construct: Construct::BodyFileLine,
        id: "body-file-line",
        support: Support::VscodeOnly,
        label: "< file among other lines",
        hover: "Rider drops the line breaks around this file's content",
        jetbrains: &[jb!("exploring-http-syntax.html#provide-request-body")],
        vscode: &[VSC_BODY],
    },
];

/// `construct`'s row. Every construct has one (a test checks).
pub fn row(construct: Construct) -> &'static Row {
    TABLE.iter().find(|r| r.construct == construct).expect("every construct has a row in TABLE")
}

/// One construct found in a text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortabilityMark {
    /// 1-based, counted from the start of the text (a byte order mark doesn't count).
    /// A construct over several lines (a script) is marked on its first.
    pub line: usize,
    pub construct: Construct,
    pub support: Support,
    pub label: &'static str,
    pub hover: &'static str,
}

/// Every construct of [`TABLE`] in `text` (a whole file or one request's text), in
/// order, once per line each. Portable ones too: callers show what they need.
pub fn portability(text: &str) -> Vec<PortabilityMark> {
    let text = text.strip_prefix(BOM).unwrap_or(text);
    let mut marks = Marks(Vec::new());
    let mut first = 1;
    for raw in parser::split_blocks(text) {
        let lines: Vec<&str> = raw.lines().collect();
        block(&raw, &lines, first, &mut marks);
        first += raw.matches('\n').count();
    }
    marks.0
}

/// [`portability`] of `request`'s source as the Source view shows it
/// ([`crate::request_source`]): the text before it, then its block as written where
/// the request still matches it, else rendered.
pub fn request_portability(request: &Request) -> Vec<PortabilityMark> {
    portability(&crate::request_source(request))
}

struct Marks(Vec<PortabilityMark>);

impl Marks {
    fn add(&mut self, line: usize, construct: Construct) {
        // Lines are added in order, so one already marked is among the last: a file's
        // thousands of marks aren't all looked through for each.
        if self.0.iter().rev().take_while(|m| m.line >= line).any(|m| m.line == line && m.construct == construct) {
            return;
        }
        let r = row(construct);
        self.0.push(PortabilityMark { line, construct, support: r.support, label: r.label, hover: r.hover });
    }

    /// The `{{…}}` references on `text`, on line `line`.
    fn references(&mut self, line: usize, text: &str) {
        for s in segments(text) {
            if let Segment::Reference { name, .. } = s {
                if let Some(c) = reference(name) {
                    self.add(line, c);
                }
            }
        }
    }
}

/// Reads one `###` block the way the parser does: preamble, request line (and its
/// query continuation lines), header area to the first blank line, body, then the
/// response handler from its first `>` line. `first` is the block's line number.
fn block(raw: &str, lines: &[&str], first: usize, marks: &mut Marks) {
    let parsed = parser::parse_block_at(raw);
    let request_line = parsed.as_ref().map(|(_, i)| *i);
    let preamble_end = request_line.unwrap_or(lines.len());
    let mut i = 0;
    while i < preamble_end {
        let (line, t) = (lines[i], lines[i].trim());
        let at = first + i;
        i += 1;
        if t.is_empty() || parser::is_separator(line) {
            continue;
        }
        if t.starts_with(DISABLED_MARKER) {
            marks.add(at, Construct::DisabledLine);
        } else if let Some(c) = parser::comment_body(t) {
            if let Some(d) = parser::preamble_directive(c) {
                if let Some(construct) = directive(&d.name) {
                    marks.add(at, construct);
                }
            }
        } else if parser::parse_variable(t).is_some() {
            marks.add(at, Construct::FileVariable);
            marks.references(at, t);
        } else if t.starts_with('<') && request_line.is_some() {
            marks.add(at, Construct::PreRequestScript);
            if t.contains("{%") && !t.contains("%}") {
                i = script_end(lines, i, preamble_end);
            }
        }
    }
    let Some((request, rl)) = parsed else { return };

    let line = lines[rl];
    if line.split_whitespace().next() == Some("GRAPHQL") {
        marks.add(first + rl, Construct::GraphqlMethod);
    }
    marks.references(first + rl, line);
    let mut i = rl + 1;
    while let Some(l) = lines.get(i) {
        let t = l.trim();
        if !(l.starts_with(char::is_whitespace) && (t.starts_with('?') || t.starts_with('&'))) {
            break;
        }
        marks.references(first + i, l);
        i += 1;
    }

    // Header area.
    while let Some(l) = lines.get(i) {
        let (t, at) = (l.trim(), first + i);
        i += 1;
        if t.is_empty() {
            break;
        }
        if t.starts_with(DISABLED_MARKER) {
            marks.add(at, Construct::DisabledLine);
        } else if parser::comment_body(t).is_none() {
            if let Some((name, value)) = t.split_once(':') {
                if name.trim().eq_ignore_ascii_case("x-request-type") && value.trim().eq_ignore_ascii_case("graphql") {
                    marks.add(at, Construct::GraphqlRequestTypeHeader);
                }
            }
            marks.references(at, l);
        }
    }

    // Body, then the response handler.
    let handler_at = (i..lines.len()).find(|&j| parser::is_handler_start(lines[j])).unwrap_or(lines.len());
    // A `< file` that is a Whole-file body or a multipart part's content both editors send as
    // it is; among other lines, Rider drops the line breaks around it.
    let whole_file_or_part = matches!(request.body.mode, BodyMode::File | BodyMode::Multipart);
    for (j, l) in lines.iter().enumerate().take(handler_at).skip(i) {
        let (t, at) = (l.trim(), first + j);
        if t.starts_with(DISABLED_MARKER) {
            marks.add(at, Construct::DisabledLine);
        } else if let Some(r) = parser::file_reference(l) {
            marks.add(
                at,
                match (r.substitute, whole_file_or_part) {
                    (true, _) => Construct::BodyFileWithVariables,
                    (false, true) => Construct::BodyFile,
                    (false, false) => Construct::BodyFileLine,
                },
            );
        } else {
            marks.references(at, l);
        }
    }
    let mut j = handler_at;
    while j < lines.len() {
        let (l, at) = (lines[j], first + j);
        j += 1;
        if l.starts_with(">>") {
            marks.add(at, Construct::ResponseRedirect);
        } else if parser::is_handler_start(l) {
            marks.add(at, Construct::ResponseHandler);
            if l.contains("{%") && !l.contains("%}") {
                j = script_end(lines, j, lines.len());
            }
        }
    }
}

/// The index after the line that closes a `{%` script opened above `from`.
fn script_end(lines: &[&str], from: usize, end: usize) -> usize {
    (from..end).find(|&k| lines[k].contains("%}")).map_or(end, |k| k + 1)
}

/// The construct a `# @name` directive is, matched ignoring case (as VS Code does).
fn directive(name: &str) -> Option<Construct> {
    let is = |n: &str| name.eq_ignore_ascii_case(n);
    Some(match () {
        _ if is("name") => Construct::NameDirective,
        _ if is("no-redirect") => Construct::NoRedirectDirective,
        _ if is("no-cookie-jar") => Construct::NoCookieJarDirective,
        _ if is("no-log") => Construct::NoLogDirective,
        _ if is("no-auto-encoding") => Construct::NoAutoEncodingDirective,
        _ if is("timeout") => Construct::TimeoutDirective,
        _ if is("connection-timeout") => Construct::ConnectionTimeoutDirective,
        _ if is("use-os-credentials") => Construct::UseOsCredentialsDirective,
        _ if is("note") => Construct::NoteDirective,
        _ if is("prompt") => Construct::PromptDirective,
        _ if is(parser::SECTION_DIRECTIVE) => Construct::HttpdeskDisabledDirective,
        _ if is(parser::AUTH_DIRECTIVE) => Construct::HttpdeskAuthDirective,
        _ if is(parser::PARAM_DOC_DIRECTIVE) || is(parser::HEADER_DOC_DIRECTIVE) => Construct::DocDirective,
        _ => return None,
    })
}

/// The construct a `{{…}}` reference (trimmed, without braces) is: a Request
/// variable or a dynamic variable one editor generates. Others are portable or
/// Undefined variables, not portability notes.
fn reference(name: &str) -> Option<Construct> {
    if split_reference(name).is_some() {
        return Some(Construct::RequestVariable);
    }
    let d = name.strip_prefix('$')?;
    let end = d.find(|c: char| c.is_whitespace() || c == '(').unwrap_or(d.len());
    let (head, args) = (&d[..end], d[end..].trim());
    Some(match head {
        "timestamp" if args.is_empty() => Construct::Timestamp,
        "timestamp" => Construct::TimestampOffset,
        "randomInt" if args.is_empty() => Construct::RandomInt,
        "randomInt" => Construct::RandomIntRange,
        "uuid" | "isoTimestamp" => Construct::JetbrainsDynamicVariable,
        h if h.starts_with("random.") || h.starts_with("env.") => Construct::JetbrainsDynamicVariable,
        "guid" | "datetime" | "localDatetime" | "processEnv" | "dotenv" => Construct::VscodeDynamicVariable,
        "aadToken" | "aadV2Token" | "oidcAccessToken" => Construct::VscodeSignInVariable,
        "exampleServer" => Construct::ExampleServer,
        _ => return None,
    })
}
