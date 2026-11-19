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
