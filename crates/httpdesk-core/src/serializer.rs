//! `HttpFile` → `.http` text.
//!
//! Lossless strategy: a request whose original text (`raw`) re-parses to the same
//! canonical output as the edited model is emitted byte-for-byte; only edited
//! requests are re-rendered. See `docs/ARCHITECTURE.md` §2.

use base64::Engine;

use crate::model::*;
use crate::parser::{self, AUTH_DIRECTIVE, DISABLED_MARKER, HEADER_DOC_DIRECTIVE, PARAM_DOC_DIRECTIVE, SECTION_DIRECTIVE};

/// A model field whose text would change the file's structure if written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct InvalidField(pub String);

/// Serializes `file`, refusing a model whose single-line fields contain line
/// breaks or whose names would be read back as something else. Use this for
/// models that come from outside (the UI); `serialize` doesn't check.
pub fn try_serialize(file: &HttpFile) -> Result<String, InvalidField> {
    check_file(file)?;
    Ok(serialize(file))
}

fn has_line_break(s: &str) -> bool {
    s.contains(['\n', '\r'])
}

/// `Err` with "`context`: `what` contains a line break" when `value` has one.
fn single_line(context: &str, what: impl FnOnce() -> String, value: &str) -> Result<(), InvalidField> {
    if has_line_break(value) {
        return Err(InvalidField(format!("{context}: {} contains a line break", what())));
    }
    Ok(())
}

fn check_file(file: &HttpFile) -> Result<(), InvalidField> {
    for c in &file.header.comments {
        single_line("File header", || "a comment line".into(), c)?;
    }
    for v in &file.header.variables {
        check_variable("File variables", v)?;
    }
    for req in &file.requests {
        check_request(req)?;
    }
    Ok(())
}

fn check_variable(context: &str, v: &Variable) -> Result<(), InvalidField> {
    single_line(context, || format!("variable name {:?}", v.name), &v.name)?;
    single_line(context, || format!("the value of variable {:?}", v.name), &v.value)?;
    // Empty names aren't written. Any other name must read back as a variable line.
    if !v.name.is_empty() && !parser::is_variable_name(&v.name) {
        return Err(InvalidField(format!(
            "{context}: variable name {:?} can only use letters, digits, _, -, . and $",
            v.name
        )));
    }
    Ok(())
}

/// Why a header line with this name would read back as something else (a
/// comment, a disabled query param or body line, or no header at all).
fn header_name_problem(name: &str) -> Option<String> {
    if name.contains(char::is_whitespace) {
        return Some("can't contain spaces".into());
    }
    if name.contains(':') {
        return Some("can't contain ':'".into());
    }
    ["//", "#", "~", "|", "&", "?"]
        .into_iter()
        .find(|p| name.starts_with(p))
        .map(|p| format!("can't start with '{p}'"))
}

fn check_header_name(context: &str, what: &str, name: &str) -> Result<(), InvalidField> {
    match header_name_problem(name) {
        Some(problem) if !name.is_empty() => Err(InvalidField(format!("{context}: {what} {name:?} {problem}"))),
        _ => Ok(()),
    }
}

fn check_items(context: &str, kind: &str, items: &[KeyValue]) -> Result<(), InvalidField> {
    for kv in items {
        single_line(context, || format!("{kind} name {:?}", kv.name), &kv.name)?;
        single_line(context, || format!("the value of {kind} {:?}", kv.name), &kv.value)?;
    }
    Ok(())
}

fn check_request(req: &Request) -> Result<(), InvalidField> {
    let context = format!("Request {:?}", req.display_name());
    let context = context.as_str();
    single_line(context, || "the name".into(), &req.name)?;
    single_line(context, || "the method".into(), &req.method)?;
    single_line(context, || "the URL".into(), &req.url)?;
    single_line(context, || "the HTTP version".into(), req.http_version.as_deref().unwrap_or(""))?;
    for d in &req.directives {
        single_line(context, || format!("directive @{}", d.name), &d.name)?;
        single_line(context, || format!("directive @{}", d.name), &d.value)?;
    }
    for v in &req.variables {
        check_variable(context, v)?;
    }
    check_items(context, "query param", &req.query.items)?;
    check_items(context, "header", &req.headers.items)?;

    let a = &req.auth;
    let auth_fields = [
        ("the username", &a.username),
        ("the password", &a.password),
        ("the bearer token", &a.token),
        ("the API key name", &a.key_name),
        ("the API key value", &a.key_value),
    ];
    for (what, value) in auth_fields {
        single_line(context, || what.into(), value)?;
    }
    for h in &req.headers.items {
        check_header_name(context, "header name", &h.name)?;
    }
    if a.kind == AuthKind::ApiKey {
        match a.key_location {
            ApiKeyLocation::Header => check_header_name(context, "API key header name", &a.key_name)?,
            // `# @httpdesk-auth apikey query <name>` splits at whitespace.
            ApiKeyLocation::Query if a.key_name.contains(char::is_whitespace) => {
                return Err(InvalidField(format!("{context}: the API key name {:?} can't contain spaces", a.key_name)));
            }
            ApiKeyLocation::Query => {}
        }
    }
    single_line(context, || "the Authorization header".into(), a.raw.as_deref().unwrap_or(""))?;
    for e in &req.extra_lines {
        single_line(context, || "a header-area line".into(), &e.text)?;
    }
    Ok(())
}

/// Splits on `\r\n`, `\r` or `\n`.
fn split_lines(s: &str) -> impl Iterator<Item = &str> {
    s.split('\n').flat_map(|l| l.strip_suffix('\r').unwrap_or(l).split('\r'))
}

pub fn serialize(file: &HttpFile) -> String {
    let mut out = String::new();
    let mut prev_rendered = false;

    let in_place = file.header.raw.as_deref().and_then(|raw| render_header_in_place(&file.header, raw));
    match in_place {
        Some(text) => {
            if !text.trim().is_empty() {
                out.push_str(&text);
            }
        }
        None => {
            out.push_str(&render_header(&file.header));
            prev_rendered = !out.is_empty();
        }
    }
    for req in &file.requests {
        if !req.leading.is_empty() {
            separate(&mut out, prev_rendered);
            out.push_str(&req.leading);
            prev_rendered = false;
        }
        let rendered = render_request(req);
        let raw = req
            .raw
            .as_ref()
            .filter(|raw| parser::parse_block(raw).map(|p| render_request(&p)).as_deref() == Some(rendered.as_str()));
        match raw {
            Some(raw) => {
                separate(&mut out, prev_rendered);
                // Only a file's first block may omit `###`; anywhere else it would
                // merge into the block before it.
                if !out.is_empty() && !parser::is_separator(raw) {
                    out.push_str("###\n");
                }
                out.push_str(raw);
                prev_rendered = false;
            }
            None => {
                separate(&mut out, true);
                out.push_str(&rendered);
                prev_rendered = true;
            }
        }
    }

    if !file.trailing.is_empty() {
        separate(&mut out, prev_rendered);
        out.push_str(&file.trailing);
    }

    if file.line_ending == LineEnding::Crlf {
        out = out.replace('\n', "\r\n");
    }
    if file.bom {
        out.insert(0, parser::BOM);
    }
    out
}

/// Ensures `out` ends with a newline, plus a blank line when `blank` is set.
fn separate(out: &mut String, blank: bool) {
    if out.is_empty() {
        return;
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if blank && !out.ends_with("\n\n") {
        out.push('\n');
    }
}

pub fn render_header(h: &FileHeader) -> String {
    let mut lines: Vec<String> = h.comments.clone();
    lines.extend(h.variables.iter().filter(|v| !v.name.is_empty()).map(render_variable));
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    }
}

/// Renders the header inside its original text so comments and blank lines stay
/// put: variable lines are updated in place (unchanged ones keep their bytes,
/// remaining ones follow the model's order), removed ones are dropped, and new
/// ones follow the last variable line. `None` when the comments were edited.
fn render_header_in_place(h: &FileHeader, raw: &str) -> Option<String> {
    if parser::parse_header(raw).comments != h.comments {
        return None;
    }
    let vars: Vec<&Variable> = h.variables.iter().filter(|v| !v.name.is_empty()).collect();
    let lines: Vec<(&str, Option<Variable>)> =
        raw.split_inclusive('\n').map(|l| (l, parser::parse_variable(l.trim()))).collect();

    // A variable line is kept while some model variable still has its name.
    let mut matched = vec![false; vars.len()];
    let kept: Vec<bool> = lines
        .iter()
        .map(|(_, orig)| {
            let Some(orig) = orig else { return false };
            let found = (0..vars.len()).find(|&j| !matched[j] && vars[j].name == orig.name);
            found.inspect(|&j| matched[j] = true).is_some()
        })
        .collect();
    let mut fill = vars.iter().zip(&matched).filter(|(_, m)| **m).map(|(v, _)| *v);
    let mut added = vars.iter().zip(&matched).filter(|(_, m)| !**m).map(|(v, _)| *v).peekable();
    let insert_after = lines
        .iter()
        .rposition(|(_, v)| v.is_some())
        .or_else(|| lines.iter().rposition(|(l, _)| !l.trim().is_empty()));

    let mut out = String::new();
    let mut push_added = |out: &mut String| {
        for v in added.by_ref() {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&render_variable(v));
            out.push('\n');
        }
    };
    if insert_after.is_none() {
        push_added(&mut out);
    }
    for (i, (line, orig)) in lines.iter().enumerate() {
        if kept[i] {
            let v = fill.next()?;
            if orig.as_ref() == Some(v) {
                out.push_str(line);
            } else {
                out.push_str(&render_variable(v));
                if line.ends_with('\n') {
                    out.push('\n');
                }
            }
        } else if orig.is_none() {
            out.push_str(line);
        }
        if Some(i) == insert_after {
            push_added(&mut out);
        }
    }
    Some(out)
}

fn render_variable(v: &Variable) -> String {
    format!("@{} = {}", v.name, v.value)
}

fn marker(depth: usize) -> String {
    if depth == 0 {
        String::new()
    } else {
        format!("{}{} ", DISABLED_MARKER, "~".repeat(depth - 1))
    }
}

fn render_param(p: &KeyValue) -> String {
    if p.value.is_empty() {
        p.name.clone()
    } else {
        format!("{}={}", p.name, p.value)
    }
}

fn render_basic(auth: &Auth) -> String {
    let (u, p) = (&auth.username, &auth.password);
    let mut v = "Basic".to_string();
    if u.is_empty() && p.is_empty() {
        return v;
    }
    v.push(' ');
    // JetBrains and VS Code split `Basic …` at the first whitespace, so a username
    // with a space (or a password with edge whitespace) only survives pre-encoded.
    if u.contains(char::is_whitespace) || p.trim() != p {
        v.push_str(&base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}")));
    } else if !u.is_empty() && !p.is_empty() && !u.contains(':') {
        v.push_str(&format!("{u} {p}"));
    } else {
        v.push_str(&format!("{u}:{p}"));
    }
    v
}

/// Canonical rendering of a single request block (always starts with `###`).
pub fn render_request(req: &Request) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(if req.name.trim().is_empty() { "###".into() } else { format!("### {}", req.name.trim()) });

    // A multi-line description entry becomes one `#` line per line.
    for c in req.comments.iter().flat_map(|c| split_lines(c)) {
        lines.push(if c.is_empty() { "#".into() } else { format!("# {c}") });
    }
    // Section names this version doesn't know, written back on the section line below.
    let mut off: Vec<&str> = Vec::new();
    for d in &req.directives {
        if d.name == SECTION_DIRECTIVE {
            off.push(&d.value);
            continue;
        }
        lines.push(if d.value.is_empty() { format!("# @{}", d.name) } else { format!("# @{} {}", d.name, d.value) });
    }
    let docs = [(PARAM_DOC_DIRECTIVE, &req.query.items), (HEADER_DOC_DIRECTIVE, &req.headers.items)];
    for (tag, items) in docs {
        for kv in items.iter().filter(|kv| !kv.name.is_empty()) {
            for l in kv.description.lines().map(str::trim).filter(|l| !l.is_empty()) {
                lines.push(format!("# @{tag} {}: {l}", kv.name));
            }
        }
    }
    if !req.headers.enabled {
        off.insert(0, "headers");
    }
    if !req.query.enabled {
        off.insert(0, "query");
    }
    if !off.is_empty() {
        lines.push(format!("# @{} {}", SECTION_DIRECTIVE, off.join(", ")));
    }
    let auth = &req.auth;
    if auth.kind == AuthKind::ApiKey {
        let loc = match auth.key_location {
            ApiKeyLocation::Header => "header",
            ApiKeyLocation::Query => "query",
        };
        lines.push(format!("# @{} apikey {} {}", AUTH_DIRECTIVE, loc, auth.key_name).trim_end().to_string());
    }
    lines.extend(req.variables.iter().filter(|v| !v.name.is_empty()).map(render_variable));
    if let Some(s) = &req.pre_script {
        lines.push(s.clone());
    }

    // Request line with enabled query params.
    let mut active: Vec<String> = req.query.active().map(render_param).collect();
    let api_key_query = auth.kind == AuthKind::ApiKey
        && auth.key_location == ApiKeyLocation::Query
        && !auth.key_name.is_empty();
    if api_key_query && auth.enabled {
        active.push(render_param(&KeyValue::new(&auth.key_name, &auth.key_value)));
    }
    let mut line = format!("{} {}", req.method.trim(), req.url.trim());
    if !active.is_empty() {
        line.push(if req.url.contains('?') { '&' } else { '?' });
        line.push_str(&active.join("&"));
    }
    if let Some(v) = &req.http_version {
        line.push(' ');
        line.push_str(v);
    }
    lines.push(line);

    // Header area as (anchor key, line): disabled query params, auth, headers.
    let mut area: Vec<(String, String)> = Vec::new();
    let section_off = usize::from(!req.query.enabled);
    for p in req.query.items.iter().filter(|p| !p.name.is_empty()) {
        let depth = usize::from(!p.enabled) + section_off;
        if depth > 0 {
            area.push((format!("&{}", p.name), format!("{}&{}", marker(depth), render_param(p))));
        }
    }
    if api_key_query && !auth.enabled {
        let p = KeyValue::new(&auth.key_name, &auth.key_value);
        area.push((format!("&{}", p.name), format!("{}&{}", marker(1), render_param(&p))));
    }

    // Auth header, as written while it still carries the same credentials.
    let as_written = auth.raw.as_ref().filter(|raw| {
        parser::parse_authorization(raw).is_some_and(|p| {
            (p.kind, &p.username, &p.password, &p.token) == (auth.kind, &auth.username, &auth.password, &auth.token)
        })
    });
    let auth_line = match (auth.kind, as_written) {
        (AuthKind::Basic | AuthKind::Bearer, Some(raw)) => Some(("Authorization", format!("Authorization: {raw}"))),
        (AuthKind::Basic, None) => Some(("Authorization", format!("Authorization: {}", render_basic(auth)))),
        (AuthKind::Bearer, None) => {
            Some(("Authorization", format!("Authorization: Bearer {}", auth.token).trim_end().to_string()))
        }
        (AuthKind::ApiKey, _) if auth.key_location == ApiKeyLocation::Header && !auth.key_name.is_empty() => {
            Some((auth.key_name.as_str(), format!("{}: {}", auth.key_name, auth.key_value).trim_end().to_string()))
        }
        _ => None,
    };
    if let Some((name, l)) = auth_line {
        area.push((name.to_string(), format!("{}{}", marker(usize::from(!auth.enabled)), l)));
    }

    let section_off = usize::from(!req.headers.enabled);
    for h in req.headers.items.iter().filter(|h| !h.name.is_empty()) {
        let depth = usize::from(!h.enabled) + section_off;
        area.push((h.name.clone(), format!("{}{}: {}", marker(depth), h.name, h.value).trim_end().to_string()));
    }

    // Extra lines go back above the line they preceded, else after the headers.
    for e in &req.extra_lines {
        let at = e.before.as_ref().and_then(|b| area.iter().position(|(k, _)| k.eq_ignore_ascii_case(b)));
        let item = (String::new(), e.text.clone());
        match at {
            Some(i) => area.insert(i, item),
            None => area.push(item),
        }
    }
    lines.extend(area.into_iter().map(|(_, l)| l));

    let body = &req.body;
    let body_text = body.text.trim_end_matches(['\n', '\r', ' ', '\t']);
    if body.is_present() && !body.enabled {
        for l in body_text.lines() {
            lines.push(if l.is_empty() { format!("{DISABLED_MARKER}|") } else { format!("{DISABLED_MARKER}| {l}") });
        }
    }
    if body.is_present() && body.enabled {
        lines.push(String::new());
        lines.push(body_text.to_string());
    }
    if let Some(h) = &req.response_handler {
        lines.push(String::new());
        lines.push(h.clone());
    }
    lines.join("\n") + "\n"
}
