//! How `{{variable}}` references sit in text. Resolving them is the core's
//! (`httpdesk_core::vars`); query escaping only needs to find them.

/// A run of plain text, or one `{{…}}` reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Segment<'a> {
    Text(&'a str),
    /// `whole` is the reference as written, braces included; `name` is what's
    /// between the braces, trimmed.
    Reference {
        whole: &'a str,
        name: &'a str,
    },
}

/// Splits `text` into plain runs and `{{…}}` references, the way the resolver
/// reads them. An unclosed `{{` is plain text.
pub fn segments(text: &str) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        out.push(Segment::Text(&rest[..start]));
        out.push(Segment::Reference {
            whole: &rest[start..start + 4 + len],
            name: rest[start + 2..start + 2 + len].trim(),
        });
        rest = &rest[start + 4 + len..];
    }
    out.push(Segment::Text(rest));
    out
}

/// For a `{{…}}` reference (trimmed, without braces): the request name and the path
/// after it when it is a Request variable (`name.response…` or `name.request…`).
/// A Request variable never falls back to a variable of the same name.
pub fn split_reference(reference: &str) -> Option<(&str, &str)> {
    let (name, path) = reference.split_once('.')?;
    let side = path.split('.').next().unwrap_or("");
    let named = !name.is_empty() && !name.starts_with('$') && !name.contains(char::is_whitespace);
    (named && matches!(side, "response" | "request")).then_some((name, path))
}
