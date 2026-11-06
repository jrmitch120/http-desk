//! Lossless formatting of request and response bodies (Beautify and the
//! response Pretty view).
//!
//! The JSON formatter works on the token stream: it validates the input and
//! rewrites only the whitespace between tokens. Number and string tokens are
//! copied byte for byte, so `9007199254740993`, `10.50`, `1e3`, `-0` and `\u`
//! escapes stay exactly as written, and duplicate keys keep their order.
//! Parsing into `serde_json::Value`, `f64` or JS numbers would change them.

use serde::Deserialize;

/// How to lay out the tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatMode {
    /// One member or element per line, indented by two spaces.
    Pretty,
    /// No whitespace between tokens.
    Minify,
}

/// The syntax of a body to format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyKind {
    Json,
}

/// Why a body couldn't be formatted (it isn't valid, or is nested too deeply).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FormatError(String);

/// Deepest nesting we format. Pretty output grows with the square of the
/// depth (each level indents every line below it), so a hostile body could
/// otherwise produce gigabytes; real documents are nowhere near this.
pub const MAX_DEPTH: usize = 1000;

const INDENT: &str = "  ";

/// Formats `text` as `kind` in `mode`. The entry point for the shell's
/// `format_body` command.
pub fn format_body(text: &str, kind: BodyKind, mode: FormatMode) -> Result<String, FormatError> {
    match kind {
        BodyKind::Json => format_json(text, mode),
    }
}

/// Re-lays out JSON `text` without changing any token, or fails if it isn't
/// valid JSON (RFC 8259). Iterative, so deep nesting can't overflow the stack.
pub fn format_json(text: &str, mode: FormatMode) -> Result<String, FormatError> {
    let mut s = Scanner { text, pos: 0 };
    let mut out =
        Writer { out: String::with_capacity(text.len() + text.len() / 4), pretty: mode == FormatMode::Pretty };
    // Open containers, innermost last: `true` for an object, `false` for an array.
    let mut stack: Vec<bool> = Vec::new();

    s.skip_ws();
    loop {
        // A value starts here.
        match s.peek() {
            Some(open @ (b'{' | b'[')) => {
                s.pos += 1;
                s.skip_ws();
                let close = if open == b'{' { b'}' } else { b']' };
                if s.peek() == Some(close) {
                    s.pos += 1;
                    out.raw(if open == b'{' { "{}" } else { "[]" });
                } else {
                    if stack.len() >= MAX_DEPTH {
                        return Err(FormatError(format!("JSON is nested more than {MAX_DEPTH} levels deep")));
                    }
                    stack.push(open == b'{');
                    out.raw(if open == b'{' { "{" } else { "[" });
                    out.newline(stack.len());
                    if open == b'{' {
                        member_key(&mut s, &mut out)?;
                    }
                    continue;
                }
            }
            Some(b'"') => out.raw(s.string()?),
            Some(b'-' | b'0'..=b'9') => out.raw(s.number()?),
            Some(b't') => out.raw(s.literal("true")?),
            Some(b'f') => out.raw(s.literal("false")?),
            Some(b'n') => out.raw(s.literal("null")?),
            _ => return Err(s.error("expected a value")),
        }

        // A value just ended: close containers until another value is due.
        loop {
            s.skip_ws();
            let Some(&is_object) = stack.last() else {
                return match s.peek() {
                    None => Ok(out.out),
                    Some(_) => Err(s.error("unexpected text after the JSON value")),
                };
            };
            let close = if is_object { b'}' } else { b']' };
            match s.peek() {
                Some(b',') => {
                    s.pos += 1;
                    out.raw(",");
                    out.newline(stack.len());
                    if is_object {
                        member_key(&mut s, &mut out)?;
                    } else {
                        s.skip_ws();
                    }
                    break;
                }
                Some(c) if c == close => {
                    s.pos += 1;
                    stack.pop();
                    out.newline(stack.len());
                    out.raw(if is_object { "}" } else { "]" });
                }
                _ => return Err(s.error(if is_object { "expected ',' or '}'" } else { "expected ',' or ']'" })),
            }
        }
    }
}

/// Reads `"key" :` inside an object and writes it, leaving the scanner at the value.
fn member_key(s: &mut Scanner, out: &mut Writer) -> Result<(), FormatError> {
    s.skip_ws();
    if s.peek() != Some(b'"') {
        return Err(s.error("expected a quoted key"));
    }
    out.raw(s.string()?);
    s.skip_ws();
    if s.peek() != Some(b':') {
        return Err(s.error("expected ':'"));
    }
    s.pos += 1;
    out.raw(if out.pretty { ": " } else { ":" });
    s.skip_ws();
    Ok(())
}

/// Builds the output; whitespace only goes in when pretty-printing.
struct Writer {
    out: String,
    pretty: bool,
}

impl Writer {
    fn raw(&mut self, s: &str) {
        self.out.push_str(s);
    }

    /// Line break and indent for `depth` levels (nothing when minifying).
    fn newline(&mut self, depth: usize) {
        if self.pretty {
            self.out.push('\n');
            for _ in 0..depth {
                self.out.push_str(INDENT);
            }
        }
    }
}

/// A cursor over the input that recognises single tokens and returns them as
/// slices of the input, so they're copied unchanged.
struct Scanner<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// A string token, quotes included. Escapes are checked, not decoded.
    fn string(&mut self) -> Result<&'a str, FormatError> {
        let start = self.pos;
        self.pos += 1; // opening quote
        loop {
            match self.peek() {
                None => return Err(self.error("unterminated string")),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(&self.text[start..self.pos]);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    match self.peek() {
                        Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => self.pos += 1,
                        Some(b'u') => {
                            self.pos += 1;
                            for _ in 0..4 {
                                if !self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                                    return Err(self.error("expected four hex digits after \\u"));
                                }
                                self.pos += 1;
                            }
                        }
                        _ => return Err(self.error("invalid escape in string")),
                    }
                }
                Some(0x00..=0x1f) => return Err(self.error("control character in string")),
                Some(_) => self.pos += 1,
            }
        }
    }

    /// A number token: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`.
    fn number(&mut self) -> Result<&'a str, FormatError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.error("expected a digit")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            self.required_digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            self.required_digits()?;
        }
        Ok(&self.text[start..self.pos])
    }

    fn digits(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
    }

    fn required_digits(&mut self) -> Result<(), FormatError> {
        if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
            return Err(self.error("expected a digit"));
        }
        self.digits();
        Ok(())
    }

    fn literal(&mut self, word: &'static str) -> Result<&'static str, FormatError> {
        if !self.text[self.pos..].starts_with(word) {
            return Err(self.error("expected a value"));
        }
        self.pos += word.len();
        Ok(word)
    }

    /// An error naming the line and column of the current position.
    fn error(&self, what: &str) -> FormatError {
        let before = &self.text[..self.pos];
        let line = before.matches('\n').count() + 1;
        let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
        FormatError(format!("Invalid JSON at line {line}, column {column}: {what}"))
    }
}
