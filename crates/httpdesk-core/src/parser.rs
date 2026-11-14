//! Lenient, line-oriented `.http` parser covering the JetBrains HTTP Client and
//! VS Code REST Client dialects. Parsing never fails: unrecognized content is
//! preserved verbatim so that saving never discards anything.
//!
//! See `docs/ARCHITECTURE.md` §2 and §5 for the grammar and the `#~` disabled
//! component encoding.

use base64::Engine;

use crate::model::*;
use crate::query::{unescape, Part};

/// Marker prefix for components disabled by HttpDesk.
pub const DISABLED_MARKER: &str = "#~";
/// Directive recording section-level toggles: `# @httpdesk-disabled query, headers`.
pub const SECTION_DIRECTIVE: &str = "httpdesk-disabled";
/// Directive identifying API-key auth: `# @httpdesk-auth apikey header X-API-Key`.
pub const AUTH_DIRECTIVE: &str = "httpdesk-auth";
/// Per-item documentation directives: `# @param name: text`, `# @header Name: text`.
/// Above the request line both JetBrains and VS Code treat them as unknown tags
/// and ignore them (docs/research/http-comment-compat.md).
pub const PARAM_DOC_DIRECTIVE: &str = "param";
pub const HEADER_DOC_DIRECTIVE: &str = "header";

const KNOWN_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

pub const BOM: char = '\u{FEFF}';

pub fn parse(text: &str) -> HttpFile {
    let (bom, text) = match text.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let line_ending = if crlf > lf { LineEnding::Crlf } else { LineEnding::Lf };
    let normalized = text.replace("\r\n", "\n");

    let mut file = HttpFile { line_ending, bom, ..Default::default() };
    let mut pending = String::new();

    for (i, raw) in split_blocks(&normalized).into_iter().enumerate() {
        if raw.is_empty() {
            continue;
        }
        match parse_block(&raw) {
            Some(mut req) => {
                req.leading = std::mem::take(&mut pending);
                req.raw = Some(raw);
                file.requests.push(req);
            }
            None if i == 0 => file.header = parse_header(&raw),
            None => pending.push_str(&raw),
        }
    }
    file.trailing = pending;
    file
}

/// Splits normalized text into raw blocks. Block 0 is the text before the first
/// `###` separator (possibly empty); every other block starts with its separator.
pub(crate) fn split_blocks(text: &str) -> Vec<String> {
    let mut blocks = vec![String::new()];
    for line in text.split_inclusive('\n') {
        if is_separator(line) {
            blocks.push(String::new());
        }
        blocks.last_mut().unwrap().push_str(line);
    }
    blocks
}

pub(crate) fn is_separator(line: &str) -> bool {
    line.starts_with("###")
}

pub(crate) fn parse_header(raw: &str) -> FileHeader {
    let mut header = FileHeader { raw: Some(raw.to_string()), ..Default::default() };
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(v) = parse_variable(t) {
            header.variables.push(v);
        } else {
            header.comments.push(line.to_string());
        }
    }
    header
}

/// Returns the text after a `#` or `//` comment prefix.
pub(crate) fn comment_body(t: &str) -> Option<&str> {
    t.strip_prefix("//").or_else(|| t.strip_prefix('#'))
}

fn strip_one_space(s: &str) -> &str {
    s.strip_prefix(' ').unwrap_or(s)
}

pub(crate) fn parse_variable(t: &str) -> Option<Variable> {
    let rest = t.strip_prefix('@')?;
    let (name, value) = rest.split_once('=')?;
    let name = name.trim();
    if !is_variable_name(name) {
        return None;
    }
    Some(Variable { name: name.to_string(), value: value.trim().to_string() })
}

/// Names an `@name = value` line can declare.
pub(crate) fn is_variable_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '$'))
}

fn parse_directive(c: &str) -> Option<Directive> {
    let rest = c.trim_start().strip_prefix('@')?;
    let end = rest.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(rest.len());
    let name = &rest[..end];
    if name.is_empty() {
        return None;
    }
    let value = rest[end..].trim_start();
    let value = value.strip_prefix('=').unwrap_or(value).trim();
    Some(Directive { name: name.to_string(), value: value.to_string() })
}

/// The values of a `# @httpdesk-disabled` line as written in a raw block's
/// preamble, in order (`query`, `headers` and unknown section names).
pub(crate) fn section_tokens(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || is_separator(t) {
            continue;
        }
        let Some(c) = comment_body(t) else {
            // Variables and pre-request scripts are preamble too; anything else is the request line.
            if t.starts_with('@') || t.starts_with('<') {
                continue;
            }
            break;
        };
        if !strip_one_space(c).starts_with('@') {
            continue;
        }
        if let Some(d) = parse_directive(c).filter(|d| d.name == SECTION_DIRECTIVE) {
            tokens.extend(section_names(&d.value).map(str::to_string));
        }
    }
    tokens
}

/// The section names in a `@httpdesk-disabled` value (comma- or space-separated).
pub(crate) fn section_names(value: &str) -> impl Iterator<Item = &str> {
    value.split(|c: char| c == ',' || c.is_whitespace()).map(str::trim).filter(|s| !s.is_empty())
}

fn is_method(token: &str) -> Option<String> {
    let upper = token.to_ascii_uppercase();
    if KNOWN_METHODS.contains(&upper.as_str()) {
        return Some(upper);
    }
    let mut chars = token.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_uppercase());
    if first_ok && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Some(token.to_string());
    }
    None
}

fn parse_request_line(t: &str) -> (String, String, Option<String>) {
    let tokens: Vec<&str> = t.split_whitespace().collect();
    let (method, rest) = match tokens.first().and_then(|t| is_method(t)) {
        Some(m) if tokens.len() >= 2 => (m, &tokens[1..]),
        _ => ("GET".to_string(), &tokens[..]),
    };
    let (url_tokens, version) = match rest.split_last() {
        Some((last, init)) if !init.is_empty() && last.starts_with("HTTP/") => (init, Some(last.to_string())),
        _ => (rest, None),
    };
    (method, url_tokens.join(" "), version)
}

/// Parses `name=value` as written in the file into its decoded form (ADR-0001).
pub(crate) fn parse_param(s: &str) -> KeyValue {
    let (n, v) = s.split_once('=').unwrap_or((s, ""));
    let equals = v.is_empty() && s.contains('=');
    KeyValue { equals, ..KeyValue::new(unescape(n, Part::Name), unescape(v, Part::Value)) }
}

/// Parses a query string (without `?`) into enabled params.
pub(crate) fn parse_query_string(qs: &str) -> Vec<KeyValue> {
    qs.split('&').filter(|p| !p.is_empty()).map(parse_param).collect()
}

fn split_header(s: &str) -> Option<(String, String)> {
    let (name, value) = s.split_once(':')?;
    let name = name.trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    Some((name.to_string(), value.trim().to_string()))
}

/// A response handler or output redirect starts at column 0 (JetBrains), so an
/// indented `>` line is body content.
pub(crate) fn is_handler_start(line: &str) -> bool {
    if line.starts_with(">>") {
        return true;
    }
    if let Some(rest) = line.strip_prefix('>') {
        let rest = rest.trim();
        return rest.starts_with("{%")
            || (!rest.is_empty() && !rest.contains(char::is_whitespace) && rest.ends_with(".js"));
    }
    false
}

/// Splits a verbatim response handler into its parts. `> {%` takes everything up
/// to the next `%}` (on the same line or a later one) as its script; lines
/// outside any part are ignored.
pub(crate) fn handler_parts(text: &str) -> Vec<HandlerPart> {
    let mut parts = Vec::new();
    let mut lines = text.split('\n').enumerate();
    while let Some((i, line)) = lines.next() {
        if let Some(rest) = line.strip_prefix(">>") {
            let (overwrite, path) = match rest.strip_prefix('!') {
                Some(p) => (true, p),
                None => (false, rest),
            };
            parts.push(HandlerPart::Redirect { path: path.trim().to_string(), overwrite });
        } else if let Some(rest) = line.strip_prefix('>') {
            let rest = rest.trim_start();
            let Some(script) = rest.strip_prefix("{%") else {
                if !rest.trim().is_empty() {
                    parts.push(HandlerPart::File { path: rest.trim().to_string() });
                }
                continue;
            };
            let source = inline_script(script, &mut lines);
            parts.push(HandlerPart::Inline { source, line: i + 1 });
        }
    }
    parts
}

/// Splits a verbatim pre-request script into its parts: `< {%` takes everything
/// up to the next `%}` as its script, `< path` is a script file.
pub(crate) fn pre_request_parts(text: &str) -> Vec<PreRequestPart> {
    let mut parts = Vec::new();
    let mut lines = text.split('\n').enumerate();
    while let Some((i, line)) = lines.next() {
        let Some(rest) = line.trim_start().strip_prefix('<') else { continue };
        let rest = rest.trim_start();
        match rest.strip_prefix("{%") {
            Some(script) => {
                let source = inline_script(script, &mut lines);
                parts.push(PreRequestPart::Inline { source, line: i + 1 });
            }
            None if !rest.trim().is_empty() => parts.push(PreRequestPart::File { path: rest.trim().to_string() }),
            None => {}
        }
    }
    parts
}

/// The text of an inline `{% … %}` script that starts with `first` (just after
/// `{%`): up to the next `%}`, taking further lines from `lines` as needed.
fn inline_script<'a>(first: &'a str, lines: &mut impl Iterator<Item = (usize, &'a str)>) -> String {
    let mut source = String::new();
    let mut current = first;
    loop {
        if let Some(end) = current.find("%}") {
            source.push_str(&current[..end]);
            break;
        }
        source.push_str(current);
        match lines.next() {
            Some((_, next)) => {
                source.push('\n');
                current = next;
            }
            None => break,
        }
    }
    source
}

fn trim_blank_lines<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    let start = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(lines.len());
    let end = lines.iter().rposition(|l| !l.trim().is_empty()).map_or(start, |e| e + 1);
    &lines[start..end]
}

/// Parses a single block. Returns `None` if it contains no request line.
pub(crate) fn parse_block(raw: &str) -> Option<Request> {
    let lines: Vec<&str> = raw.lines().collect();
    let mut idx = 0;
    let mut req = Request::default();

    if lines.first().is_some_and(|l| is_separator(l)) {
        req.name = lines[0].trim_start_matches('#').trim().to_string();
        idx = 1;
    }

    let mut query_marked_disabled = false;
    let mut headers_marked_disabled = false;
    let mut api_key: Option<(ApiKeyLocation, String)> = None;
    let mut docs: Vec<Directive> = Vec::new();

    // ---- preamble ----
    let request_line = loop {
        let line = *lines.get(idx)?;
        let t = line.trim();
        idx += 1;
        if t.is_empty() {
            continue;
        }
        if let Some(c) = comment_body(t) {
            // `# @name` or `#@name`. An indented `#   @x` is description text.
            let directive = if strip_one_space(c).starts_with('@') { parse_directive(c) } else { None };
            match directive {
                Some(d) if d.name == SECTION_DIRECTIVE => {
                    let mut unknown = Vec::new();
                    for s in section_names(&d.value) {
                        match s {
                            "query" | "params" => query_marked_disabled = true,
                            "headers" => headers_marked_disabled = true,
                            other => unknown.push(other),
                        }
                    }
                    // Kept so the serializer writes them back on the section line.
                    if !unknown.is_empty() {
                        req.directives.push(Directive { name: d.name, value: unknown.join(", ") });
                    }
                }
                Some(d) if d.name == AUTH_DIRECTIVE => {
                    let parts: Vec<&str> = d.value.split_whitespace().collect();
                    if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("apikey")) {
                        let loc = match parts.get(1) {
                            Some(l) if l.eq_ignore_ascii_case("query") => ApiKeyLocation::Query,
                            _ => ApiKeyLocation::Header,
                        };
                        api_key = Some((loc, parts.get(2).unwrap_or(&"").to_string()));
                    } else {
                        req.directives.push(d);
                    }
                }
                Some(d)
                    if d.name.eq_ignore_ascii_case(PARAM_DOC_DIRECTIVE)
                        || d.name.eq_ignore_ascii_case(HEADER_DOC_DIRECTIVE) =>
                {
                    docs.push(d)
                }
                Some(d) => req.directives.push(d),
                None => req.comments.push(strip_one_space(c).to_string()),
            }
            continue;
        }
        if t.starts_with('@') {
            if let Some(v) = parse_variable(t) {
                req.variables.push(v);
                continue;
            }
        }
        if t.starts_with('<') {
            let mut script = vec![line];
            if t.contains("{%") && !t.contains("%}") {
                while let Some(l) = lines.get(idx) {
                    script.push(l);
                    idx += 1;
                    if l.contains("%}") {
                        break;
                    }
                }
            }
            req.pre_script = Some(match req.pre_script.take() {
                Some(prev) => format!("{prev}\n{}", script.join("\n")),
                None => script.join("\n"),
            });
            continue;
        }
        break t;
    };

    let (method, mut url, version) = parse_request_line(request_line);
    req.method = method;
    req.http_version = version;

    // ---- multi-line query continuation ----
    while let Some(l) = lines.get(idx) {
        let t = l.trim();
        if l.starts_with(char::is_whitespace) && (t.starts_with('?') || t.starts_with('&')) {
            url.push_str(t);
            idx += 1;
        } else {
            break;
        }
    }

    let mut query_items: Vec<(usize, KeyValue)> = Vec::new();
    match url.split_once('?') {
        Some((base, qs)) => {
            query_items.extend(parse_query_string(qs).into_iter().map(|p| (0, p)));
            req.url = base.to_string();
        }
        None => req.url = url,
    }

    // ---- header area ----
    let mut header_items: Vec<(usize, KeyValue)> = Vec::new();
    let mut disabled_body: Vec<String> = Vec::new();
    let mut disabled_body_raw: Vec<String> = Vec::new();
    let mut disabled_parts: Vec<String> = Vec::new();
    let mut disabled_parts_raw: Vec<String> = Vec::new();
    // Extra lines from this index on are still waiting for the line they sit above.
    let mut unanchored = 0;
    while let Some(line) = lines.get(idx) {
        let t = line.trim();
        idx += 1;
        if t.is_empty() {
            break;
        }
        let anchor = if let Some(after) = t.strip_prefix(DISABLED_MARKER) {
            let depth = 1 + after.chars().take_while(|c| *c == '~').count();
            let rest = after.trim_start_matches('~');
            // A disabled multipart part: held inline in the body text as `#~` lines.
            if let Some(p) = rest.strip_prefix('=') {
                disabled_parts.push(format!("{DISABLED_MARKER}{p}"));
                disabled_parts_raw.push(line.to_string());
                continue;
            }
            if let Some(b) = rest.strip_prefix('|') {
                disabled_body.push(strip_one_space(b).to_string());
                disabled_body_raw.push(line.to_string());
                continue;
            }
            let rest = rest.trim_start();
            if let Some(p) = rest.strip_prefix('&').or_else(|| rest.strip_prefix('?')) {
                let p = parse_param(p);
                let key = format!("&{}", p.name);
                query_items.push((depth, p));
                Some(key)
            } else if let Some((n, v)) = split_header(rest) {
                header_items.push((depth, KeyValue::new(n.clone(), v)));
                Some(n)
            } else {
                None
            }
        } else if comment_body(t).is_some() {
            None
        } else if let Some((n, v)) = split_header(t) {
            header_items.push((0, KeyValue::new(n.clone(), v)));
            Some(n)
        } else {
            None
        };
        match anchor {
            Some(key) => {
                for e in &mut req.extra_lines[unanchored..] {
                    e.before = Some(key.clone());
                }
                unanchored = req.extra_lines.len();
            }
            None => req.extra_lines.push(ExtraLine::new(*line)),
        }
    }

    // ---- body + response handler ----
    let rest = &lines[idx.min(lines.len())..];
    let handler_at = rest.iter().position(|l| is_handler_start(l)).unwrap_or(rest.len());
    let body_lines = trim_blank_lines(&rest[..handler_at]);
    let handler_lines = trim_blank_lines(&rest[handler_at..]);
    if !handler_lines.is_empty() {
        req.response_handler = Some(handler_lines.join("\n"));
    }

    // ---- auth extraction (before section logic, auth is independent) ----
    if let Some((loc, key_name)) = api_key {
        let items = match loc {
            ApiKeyLocation::Header => &mut header_items,
            ApiKeyLocation::Query => &mut query_items,
        };
        let found = items.iter().position(|(_, kv)| kv.name.eq_ignore_ascii_case(&key_name));
        let (enabled, name, value) = match found {
            Some(pos) => {
                let (depth, kv) = items.remove(pos);
                (depth == 0, kv.name, kv.value)
            }
            None => (true, key_name, String::new()),
        };
        req.auth = Auth {
            enabled,
            kind: AuthKind::ApiKey,
            key_name: name,
            key_value: value,
            key_location: loc,
            ..Default::default()
        };
    } else {
        let candidate = |want_active: bool| {
            header_items.iter().position(|(d, kv)| {
                (*d == 0) == want_active
                    && kv.name.eq_ignore_ascii_case("authorization")
                    && parse_authorization(&kv.value).is_some()
            })
        };
        if let Some(pos) = candidate(true).or_else(|| candidate(false)) {
            let (depth, kv) = header_items.remove(pos);
            let mut auth = parse_authorization(&kv.value).unwrap();
            auth.enabled = depth == 0;
            auth.raw = Some(kv.value);
            req.auth = auth;
        }
    }

    req.query = resolve_section(query_items, query_marked_disabled);
    req.headers = resolve_section(header_items, headers_marked_disabled);
    attach_docs(&mut req, docs);

    // ---- body ----
    let content_type = req.header("content-type").map(|h| h.value.clone());
    if !body_lines.is_empty() {
        let text = body_lines.join("\n");
        req.body = Body { enabled: true, mode: detect_body_mode(content_type.as_deref(), &text), text };
        // Stale disabled body next to an active one: keep it rather than drop it.
        req.extra_lines.extend(disabled_body_raw.into_iter().map(ExtraLine::new));
    } else if !disabled_body.is_empty() {
        let refs: Vec<&str> = disabled_body.iter().map(String::as_str).collect();
        let text = trim_blank_lines(&refs).join("\n");
        req.body = Body { enabled: false, mode: detect_body_mode(content_type.as_deref(), &text), text };
    }
    if !disabled_parts.is_empty() {
        if req.body.mode == BodyMode::Multipart {
            req.body.text = insert_disabled_parts(&req.body.text, &disabled_parts);
        } else {
            req.extra_lines.extend(disabled_parts_raw.into_iter().map(ExtraLine::new));
        }
    }

    Some(req)
}

/// Puts disabled part lines before the closing `--boundary--` line, or at the end.
fn insert_disabled_parts(text: &str, parts: &[String]) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    let closing = lines.last().is_some_and(|l| {
        let t = l.trim();
        t.len() > 4 && t.starts_with("--") && t.ends_with("--")
    });
    let at = if closing { lines.len() - 1 } else { lines.len() };
    lines.splice(at..at, parts.iter().map(String::as_str));
    lines.join("\n")
}

fn resolve_section(items: Vec<(usize, KeyValue)>, marked_disabled: bool) -> KvSection {
    // An uncommented item means someone re-enabled it externally: content wins.
    let section_disabled = marked_disabled && !items.iter().any(|(d, _)| *d == 0);
    let offset = usize::from(section_disabled);
    KvSection {
        enabled: !section_disabled,
        items: items
            .into_iter()
            .map(|(depth, mut kv)| {
                kv.enabled = depth.saturating_sub(offset) == 0;
                kv
            })
            .collect(),
    }
}

/// Recognizes `Basic` and `Bearer` Authorization header values.
pub(crate) fn parse_authorization(value: &str) -> Option<Auth> {
    let value = value.trim();
    let (scheme, creds) = match value.split_once(char::is_whitespace) {
        Some((s, c)) => (s, c.trim()),
        None => (value, ""),
    };
    if scheme.eq_ignore_ascii_case("bearer") {
        return Some(Auth { kind: AuthKind::Bearer, token: creds.to_string(), ..Default::default() });
    }
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let (username, password) = parse_basic_credentials(creds)?;
    Some(Auth { kind: AuthKind::Basic, username, password, ..Default::default() })
}

fn parse_basic_credentials(creds: &str) -> Option<(String, String)> {
    if creds.is_empty() {
        return Some((String::new(), String::new()));
    }
    let first = creds.split_whitespace().next().unwrap_or("");
    if first.contains(':') {
        // `user:password` (VS Code)
        let (u, p) = creds.split_once(':').unwrap();
        return Some((u.to_string(), p.to_string()));
    }
    if let Some((u, p)) = creds.split_once(char::is_whitespace) {
        // `user password` (JetBrains and VS Code)
        return Some((u.to_string(), p.trim().to_string()));
    }
    // Pre-encoded base64 `dXNlcjpwYXNz`
    let decoded = base64::engine::general_purpose::STANDARD.decode(creds).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (u, p) = decoded.split_once(':')?;
    Some((u.to_string(), p.to_string()))
}

/// A body file reference parsed from one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileReference<'a> {
    /// `<@ path`: substitute variables in the file's content.
    pub substitute: bool,
    pub path: &'a str,
}

/// Reads `< path` or `<@ path` (the space is optional) from a single line. The
/// editor and the sender both use this rule. `<tag>`, `<?xml` and `<<` are content.
pub fn file_reference(line: &str) -> Option<FileReference<'_>> {
    let t = line.trim();
    if t.contains('\n') || t.starts_with("<?") {
        return None;
    }
    let rest = t.strip_prefix('<')?;
    let (substitute, path) = match rest.strip_prefix('@') {
        Some(p) => (true, p),
        None => (false, rest),
    };
    let path = path.trim();
    (!path.is_empty() && !path.starts_with('<') && !path.contains('>')).then_some(FileReference { substitute, path })
}

pub fn detect_body_mode(content_type: Option<&str>, text: &str) -> BodyMode {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return BodyMode::None;
    }
    if file_reference(trimmed).is_some() {
        return BodyMode::File;
    }
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if ct.contains("json") {
        BodyMode::Json
    } else if ct.contains("xml") {
        BodyMode::Xml
    } else if ct.contains("x-www-form-urlencoded") {
        BodyMode::FormUrlEncoded
    } else if ct.starts_with("multipart/") {
        BodyMode::Multipart
    } else if ct.starts_with("text/") {
        BodyMode::Text
    } else if !ct.is_empty() {
        BodyMode::Raw
    } else if trimmed.starts_with('{') || trimmed.starts_with('[') {
        BodyMode::Json
    } else if trimmed.starts_with('<') {
        BodyMode::Xml
    } else {
        BodyMode::Text
    }
}

/// Attaches `@param` / `@header` docs to the first item with that name (params
/// match exactly, headers case-insensitively). Repeated lines append. Docs that
/// match nothing, or have no text, stay as directives so they're never dropped.
fn attach_docs(req: &mut Request, docs: Vec<Directive>) {
    for d in docs {
        let is_header = d.name.eq_ignore_ascii_case(HEADER_DOC_DIRECTIVE);
        let target = d.value.split_once(':').and_then(|(name, text)| {
            let name = name.trim();
            let items = if is_header { &mut req.headers.items } else { &mut req.query.items };
            let item =
                items
                    .iter_mut()
                    .find(|kv| if is_header { kv.name.eq_ignore_ascii_case(name) } else { kv.name == name })?;
            Some((item, text.trim().to_string()))
        });
        match target {
            Some((item, text)) if !text.is_empty() => {
                if !item.description.is_empty() {
                    item.description.push('\n');
                }
                item.description.push_str(&text);
            }
            _ => req.directives.push(d),
        }
    }
}
