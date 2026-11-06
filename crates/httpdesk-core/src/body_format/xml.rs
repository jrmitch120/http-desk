//! XML Beautify and Pretty view. Every tag and text run is copied as written;
//! only whitespace between elements is replaced by line breaks and indents.

use super::{FormatError, FormatMode, INDENT, MAX_DEPTH};

/// One piece of the document, as a byte range of the input.
#[derive(Debug, Clone, Copy)]
enum Token<'a> {
    /// `<name …>`, with the element's name.
    Start(&'a str),
    /// `</name>`, with the element's name.
    End(&'a str),
    /// `<name …/>`.
    Empty,
    /// Other markup, which stands alone on its line: `<?…?>`, `<!--…-->`,
    /// `<!DOCTYPE …>`.
    Markup,
    /// Character data between markup.
    Text,
}

type Span<'a> = (usize, usize, Token<'a>);

/// Re-lays out XML `text` one element per line, or fails if its tags don't
/// nest properly.
pub fn format_xml(text: &str, mode: FormatMode) -> Result<String, FormatError> {
    let tokens = tokenize(text)?;
    let elements = elements(text, &tokens)?;

    let pretty = mode == FormatMode::Pretty;
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let line = |out: &mut String, s: &str, depth: usize| {
        if pretty && !out.is_empty() {
            out.push('\n');
            for _ in 0..depth {
                out.push_str(INDENT);
            }
        }
        out.push_str(s);
    };
    let mut depth = 0usize;
    let mut i = 0;
    while i < tokens.len() {
        let (start, end, token) = tokens[i];
        match token {
            Token::Start(_) => {
                let Element { close, inline } = elements[i];
                if inline {
                    line(&mut out, &text[start..tokens[close].1], depth);
                    i = close;
                } else {
                    line(&mut out, &text[start..end], depth);
                    depth += 1;
                }
            }
            Token::End(_) => {
                depth -= 1;
                line(&mut out, &text[start..end], depth);
            }
            Token::Empty | Token::Markup => line(&mut out, &text[start..end], depth),
            Token::Text => {} // only whitespace here, since text keeps its element inline
        }
        i += 1;
    }
    Ok(out)
}

/// What the layout needs to know about the element a start tag opens.
#[derive(Debug, Clone, Copy, Default)]
struct Element {
    /// Index of the matching end tag.
    close: usize,
    /// Copy the whole element as written, on one line of the layout: it holds
    /// only text (`<b>text</b>`), or it mixes text with child elements, where
    /// whitespace is content and re-indenting would change it.
    inline: bool,
}

/// An element being read: its start tag's index, and what it holds so far.
struct Open {
    index: usize,
    text: bool,
    children: bool,
}

/// For each start tag (by token index), its [`Element`]. Checks that tags
/// nest, that there's an element, and that no text is outside elements.
fn elements(text: &str, tokens: &[Span]) -> Result<Vec<Element>, FormatError> {
    let mut elements = vec![Element::default(); tokens.len()];
    let mut open: Vec<Open> = Vec::new();
    let mut root = false;
    for (i, &(start, end, token)) in tokens.iter().enumerate() {
        match token {
            Token::Start(_) => {
                if open.len() >= MAX_DEPTH {
                    return Err(error(text, start, &format!("XML is nested more than {MAX_DEPTH} levels deep")));
                }
                if let Some(parent) = open.last_mut() {
                    parent.children = true;
                }
                open.push(Open { index: i, text: false, children: false });
                root = true;
            }
            Token::Empty => {
                if let Some(parent) = open.last_mut() {
                    parent.children = true;
                }
                root = true;
            }
            Token::End(name) => {
                let Some(o) = open.pop() else {
                    return Err(error(text, start, &format!("</{name}> has no matching start tag")));
                };
                let Token::Start(opened) = tokens[o.index].2 else { unreachable!() };
                if opened != name {
                    return Err(error(text, start, &format!("expected </{opened}>, found </{name}>")));
                }
                elements[o.index] = Element { close: i, inline: o.text || !o.children };
            }
            Token::Markup => {
                if let Some(parent) = open.last_mut() {
                    parent.children = true;
                }
            }
            Token::Text => {
                let content = !text[start..end].trim().is_empty();
                match open.last_mut() {
                    Some(parent) => parent.text |= content,
                    None if content => return Err(error(text, start, "text outside the root element")),
                    None => {}
                }
            }
        }
    }
    if let Some(o) = open.last() {
        let Token::Start(name) = tokens[o.index].2 else { unreachable!() };
        return Err(error(text, text.len(), &format!("<{name}> is never closed")));
    }
    if !root {
        return Err(error(text, text.len(), "expected an element"));
    }
    Ok(elements)
}

/// Splits `text` into markup and text runs.
fn tokenize(text: &str) -> Result<Vec<Span<'_>>, FormatError> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let start = pos;
        if bytes[pos] != b'<' {
            pos = text[pos..].find('<').map_or(bytes.len(), |n| pos + n);
            tokens.push((start, pos, Token::Text));
            continue;
        }
        if let Some(end) = delimited(text, pos, "<?", "?>")?.or(delimited(text, pos, "<!--", "-->")?) {
            pos = end;
            tokens.push((start, pos, Token::Markup));
            continue;
        }
        if let Some(end) = delimited(text, pos, "<![CDATA[", "]]>")? {
            pos = end;
            tokens.push((start, pos, Token::Text)); // character data, like text
            continue;
        }
        pos = tag_end(text, pos)?;
        let inner = &text[start + 1..pos - 1];
        if inner.starts_with('!') {
            tokens.push((start, pos, Token::Markup)); // `<!DOCTYPE …>`
            continue;
        }
        let (end_tag, rest) = match inner.strip_prefix('/') {
            Some(rest) => (true, rest),
            None => (false, inner.strip_suffix('/').unwrap_or(inner)),
        };
        let name = rest.split(|c: char| c.is_whitespace()).next().unwrap_or("");
        if name.is_empty() {
            return Err(error(text, start + 1 + usize::from(end_tag), "expected an element name"));
        }
        let token = if end_tag {
            Token::End(name)
        } else if rest.len() < inner.len() {
            Token::Empty
        } else {
            Token::Start(name)
        };
        tokens.push((start, pos, token));
    }
    Ok(tokens)
}

/// The end of the tag starting at `pos`: just past the first `>` that isn't
/// inside a quoted attribute value or, for `<!DOCTYPE … [ … ]>`, inside the
/// brackets of the internal subset.
fn tag_end(text: &str, pos: usize) -> Result<usize, FormatError> {
    let mut quote = None;
    let mut brackets = 0usize;
    for (i, &c) in text.as_bytes()[pos..].iter().enumerate() {
        match (quote, c) {
            (None, b'"' | b'\'') => quote = Some(c),
            (None, b'[') => brackets += 1,
            (None, b']') => brackets = brackets.saturating_sub(1),
            (None, b'>') if brackets == 0 => return Ok(pos + i + 1),
            (Some(q), _) if c == q => quote = None,
            _ => {}
        }
    }
    Err(error(text, pos, "unterminated tag"))
}

/// If `open` starts at `pos`, the end of the construct after the next
/// `close`; an error if there's none.
fn delimited(text: &str, pos: usize, open: &str, close: &str) -> Result<Option<usize>, FormatError> {
    if !text[pos..].starts_with(open) {
        return Ok(None);
    }
    let from = pos + open.len();
    match text[from..].find(close) {
        Some(n) => Ok(Some(from + n + close.len())),
        None => Err(error(text, pos, &format!("{open} without a closing {close}"))),
    }
}

fn error(text: &str, pos: usize, what: &str) -> FormatError {
    FormatError::at("XML", text, pos, what)
}
