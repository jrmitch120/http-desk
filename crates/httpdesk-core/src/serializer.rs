//! `HttpFile` → `.http` text.
//!
//! Lossless strategy: a request whose original text (`raw`) re-parses to the same
//! canonical output as the edited model is emitted byte-for-byte; only edited
//! requests are re-rendered. See `docs/ARCHITECTURE.md` §2.

use crate::model::*;
use crate::parser::{self, AUTH_DIRECTIVE, DISABLED_MARKER, SECTION_DIRECTIVE};

pub fn serialize(file: &HttpFile) -> String {
    let mut out = String::new();
    let mut prev_rendered = false;

    let header_text = render_header(&file.header);
    let header_raw = file
        .header
        .raw
        .as_ref()
        .filter(|raw| render_header(&parser::parse_header(raw)) == header_text);
    match header_raw {
        Some(raw) => out.push_str(raw),
        None if !header_text.is_empty() => {
            out.push_str(&header_text);
            prev_rendered = true;
        }
        None => {}
    }
    let has_header = !header_text.is_empty();

    for (i, req) in file.requests.iter().enumerate() {
        if !req.leading.is_empty() {
            separate(&mut out, prev_rendered);
            out.push_str(&req.leading);
            prev_rendered = false;
        }
        let rendered = render_request(req);
        let raw = req.raw.as_ref().filter(|raw| {
            // A header followed by a request without `###` would merge into one block.
            let needs_separator = i == 0 && has_header && req.leading.is_empty();
            !(needs_separator && !raw.starts_with("###"))
                && parser::parse_block(raw).map(|p| render_request(&p)).as_deref()
                    == Some(rendered.as_str())
        });
        match raw {
            Some(raw) => {
                separate(&mut out, prev_rendered);
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

    match file.line_ending {
        LineEnding::Lf => out,
        LineEnding::Crlf => out.replace('\n', "\r\n"),
    }
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
    if !u.is_empty() && !p.is_empty() && !u.contains(':') && !u.contains(char::is_whitespace) {
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

    for c in &req.comments {
        lines.push(if c.is_empty() { "#".into() } else { format!("# {c}") });
    }
    for d in &req.directives {
        lines.push(if d.value.is_empty() { format!("# @{}", d.name) } else { format!("# @{} {}", d.name, d.value) });
    }
    let mut off = Vec::new();
    if !req.query.enabled {
        off.push("query");
    }
    if !req.headers.enabled {
        off.push("headers");
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

    // Disabled query params (item and/or section disabled).
    let section_off = usize::from(!req.query.enabled);
    for p in req.query.items.iter().filter(|p| !p.name.is_empty()) {
        let depth = usize::from(!p.enabled) + section_off;
        if depth > 0 {
            lines.push(format!("{}&{}", marker(depth), render_param(p)));
        }
    }
    if api_key_query && !auth.enabled {
        lines.push(format!("{}&{}", marker(1), render_param(&KeyValue::new(&auth.key_name, &auth.key_value))));
    }

    // Auth header.
    let auth_line = match auth.kind {
        AuthKind::Basic => Some(format!("Authorization: {}", render_basic(auth))),
        AuthKind::Bearer => Some(format!("Authorization: Bearer {}", auth.token).trim_end().to_string()),
        AuthKind::ApiKey if auth.key_location == ApiKeyLocation::Header && !auth.key_name.is_empty() => {
            Some(format!("{}: {}", auth.key_name, auth.key_value).trim_end().to_string())
        }
        _ => None,
    };
    if let Some(l) = auth_line {
        lines.push(format!("{}{}", marker(usize::from(!auth.enabled)), l));
    }

    let section_off = usize::from(!req.headers.enabled);
    for h in req.headers.items.iter().filter(|h| !h.name.is_empty()) {
        let depth = usize::from(!h.enabled) + section_off;
        lines.push(format!("{}{}: {}", marker(depth), h.name, h.value).trim_end().to_string());
    }
    lines.extend(req.extra_lines.iter().cloned());

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
