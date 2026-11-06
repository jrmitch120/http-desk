//! Query param text per ADR-0001. The model holds decoded names and values.
//! [`escape`] writes them for the `.http` file, percent-escaping only what would
//! change the query's structure on reload; [`unescape`] reads them back. Any
//! other `%XX` stays as written, so hand-written escapes survive a re-save.
//! [`encode`] percent-encodes the rest at send time without touching `%XX`.
//! `{{variable}}` references are never escaped.

/// Which side of `name=value` a piece of text is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    Name,
    Value,
}

/// Characters that would change the query's structure if written as-is.
fn structural(c: char, part: Part) -> bool {
    c.is_whitespace() || matches!(c, '%' | '&' | '#') || (part == Part::Name && c == '=')
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// The byte of a `%XX` escape at the start of `s`.
fn escaped_byte(s: &[u8]) -> Option<u8> {
    match s {
        [b'%', h, l, ..] => Some(hex(*h)? << 4 | hex(*l)?),
        _ => None,
    }
}

/// The character that the `%XX` escapes at the start of `s` decode to (one to four
/// bytes of UTF-8), with the length of text they take up.
fn escaped_char(s: &str) -> Option<(char, usize)> {
    let bytes = s.as_bytes();
    let lead = escaped_byte(bytes)?;
    let len = match lead {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => return None,
    };
    let mut buf = Vec::with_capacity(len);
    for i in 0..len {
        buf.push(escaped_byte(bytes.get(i * 3..)?)?);
    }
    let c = std::str::from_utf8(&buf).ok()?.chars().next()?;
    Some((c, len * 3))
}

/// Splits `text` into plain runs and `{{…}}` references, as the resolver finds them.
fn segments(text: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        out.push((false, &rest[..start]));
        out.push((true, &rest[start..start + 4 + len]));
        rest = &rest[start + 4 + len..];
    }
    out.push((false, rest));
    out
}

fn push_encoded(out: &mut String, c: char) {
    let mut buf = [0; 4];
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{b:02X}"));
    }
}

/// Writes a decoded name or value for the file.
pub(crate) fn escape(text: &str, part: Part) -> String {
    let mut out = String::with_capacity(text.len());
    for (reference, s) in segments(text) {
        if reference {
            out.push_str(s);
            continue;
        }
        for (i, c) in s.char_indices() {
            if c == '%' {
                // A `%` is only escaped where it would otherwise be read back as an
                // escape, or would sit right before one (`100% of` -> `100%25%20of`).
                let reads_as_escape = escaped_char(&s[i..]).is_some_and(|(d, _)| structural(d, part));
                let before_escape = s[i + 1..].chars().next().is_some_and(|n| structural(n, part));
                out.push_str(if reads_as_escape || before_escape { "%25" } else { "%" });
            } else if structural(c, part) {
                push_encoded(&mut out, c);
            } else {
                out.push(c);
            }
        }
    }
    out
}

/// Resolves the `{{…}}` references in an escaped name or value with `resolve` and
/// percent-encodes the result for the wire. Existing `%XX` escapes are kept, so
/// nothing is encoded twice. A `+` written in the file is kept (it reads as a space
/// to most servers); one that comes from a variable is encoded, so it arrives as `+`.
pub(crate) fn encode(text: &str, part: Part, resolve: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    for (reference, s) in segments(text) {
        if reference {
            push_wire(&mut out, &resolve(s), part, false);
        } else {
            push_wire(&mut out, s, part, true);
        }
    }
    out
}

fn push_wire(out: &mut String, text: &str, part: Part, keep_plus: bool) {
    for (i, c) in text.char_indices() {
        let kept = c.is_ascii_alphanumeric()
            || "-._~!$'()*,;:@/?".contains(c)
            || (c == '+' && keep_plus)
            || (c == '=' && part == Part::Value)
            || (c == '%' && escaped_byte(&text.as_bytes()[i..]).is_some());
        if kept {
            out.push(c);
        } else {
            push_encoded(out, c);
        }
    }
}

/// Reads a name or value written by [`escape`] (or by hand) back to its decoded form.
pub(crate) fn unescape(text: &str, part: Part) -> String {
    let mut out = String::with_capacity(text.len());
    for (reference, s) in segments(text) {
        if reference {
            out.push_str(s);
            continue;
        }
        let mut i = 0;
        while let Some(c) = s[i..].chars().next() {
            match escaped_char(&s[i..]).filter(|(d, _)| structural(*d, part)) {
                Some((d, len)) => {
                    out.push(d);
                    i += len;
                }
                None => {
                    out.push(c);
                    i += c.len_utf8();
                }
            }
        }
    }
    out
}
