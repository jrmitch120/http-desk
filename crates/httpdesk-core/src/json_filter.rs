//! JSONPath filtering of JSON response bodies (the response filter bar).
//!
//! Expressions are RFC 9535 JSONPath, evaluated by `serde_json_path` against
//! the body parsed into a `serde_json::Value`. That value is only used to
//! decide *what* matches. What's shown is copied from the body's own text: each
//! match's location (its normalized path) is found in the original bytes, and
//! that slice is laid out by the lossless formatter (`body_format`). So
//! `9007199254740993`, `10.50`, `1e3` and `"\u00e9"` appear exactly as the
//! server sent them.
//!
//! (serde_json's `arbitrary_precision` feature isn't enough for that: it keeps
//! digits but rewrites exponents, `1e3` -> `1e+3`, and re-escapes strings. It
//! would also switch on for Tauri across the workspace build.)
//!
//! A body is parsed once into a [`JsonDocument`] and then queried for every
//! expression the user types; the shell keeps recent documents by response id.
//! The document also carries the body's [`Shape`] (the keys reachable at each
//! place), which the filter bar completes keys from.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;
use serde_json_path::{JsonPath, NormalizedPath, PathElement};

use crate::body_format::{format_json, FormatMode};

/// Why a filter couldn't run: the expression isn't valid JSONPath, or the
/// body isn't valid JSON. The message is shown inline under the filter bar.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FilterError(String);

/// What a filter selected: how many nodes matched, and the matches as a
/// pretty-printed JSON array (always an array, so one match and none look
/// like the same kind of result and the editor can fold it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FilterResult {
    pub matches: usize,
    pub text: String,
}

/// A JSON body parsed for querying, plus its original text to copy matches from.
#[derive(Debug)]
pub struct JsonDocument {
    text: String,
    root: Value,
    /// Built on first use, then kept with the document (one per response).
    shape: OnceLock<Shape>,
}

impl JsonDocument {
    /// Parses `text` (a leading byte order mark is ignored). Fails for invalid
    /// JSON, and for nesting deeper than serde_json's limit of 128 levels
    /// (which the formatter, allowing 1000, would still lay out).
    pub fn parse(text: &str) -> Result<Self, FilterError> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let root = serde_json::from_str(text).map_err(|e| {
            // serde_json has no error category for its depth limit, only this message.
            if e.to_string().starts_with("recursion limit exceeded") {
                FilterError("This body is nested too deeply to filter".into())
            } else {
                FilterError(format!("The body isn't valid JSON: {e}"))
            }
        })?;
        Ok(JsonDocument { text: text.to_owned(), root, shape: OnceLock::new() })
    }

    /// The keys reachable at each place in the body, for key completion.
    /// Computed the first time it's asked for, then reused.
    pub fn shape(&self) -> &Shape {
        self.shape.get_or_init(|| Shape::of(&self.root))
    }

    /// Evaluates the JSONPath `expression` against the document.
    pub fn filter(&self, expression: &str) -> Result<FilterResult, FilterError> {
        let path = JsonPath::parse(expression.trim())
            .map_err(|e| FilterError(format!("Invalid JSONPath at position {}: {}", e.position(), e.message())))?;
        let located = path.query_located(&self.root).all();
        let locations: Vec<&NormalizedPath> = located.iter().map(|n| n.location()).collect();
        let spans = source_spans(&self.text, &locations);

        let mut text = String::from("[");
        for (i, span) in spans.into_iter().enumerate() {
            let item = format_json(&self.text[span], FormatMode::Pretty).map_err(|e| FilterError(e.to_string()))?;
            text.push_str(if i == 0 { "\n  " } else { ",\n  " });
            // JSON strings can't hold a raw newline, so every newline is layout.
            text.push_str(&item.replace('\n', "\n  "));
        }
        text.push_str(if located.is_empty() { "]" } else { "\n]" });
        Ok(FilterResult { matches: located.len(), text })
    }
}

/// At most this many keys are kept per place in a [`Shape`]. Objects used as
/// maps (keyed by id) can have far more, and nobody picks from thousands.
pub const MAX_SHAPE_KEYS: usize = 1000;

/// A summary of a JSON body's structure for key completion: the member names
/// seen at a place, and what the elements of arrays there look like. Arrays
/// are summarised by merging all their elements, so `$.items[*]` offers every
/// key any item has. A place that holds objects in one item and arrays in
/// another has both. Scalars have neither.
///
/// Serialised as `{"keys": [[name, Shape], ...], "items": Shape}` (both
/// optional). Keys are pairs in document order rather than an object, because
/// a JS object would move integer-like keys to the front.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Shape {
    /// Member names in first-seen order (at most [`MAX_SHAPE_KEYS`]), each
    /// with the merged shape of its values.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<(String, Shape)>,
    /// The merged shape of array elements here; `Some` for any array, even empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<Shape>>,
}

impl Shape {
    fn of(value: &Value) -> Shape {
        let mut builder = ShapeBuilder::default();
        builder.add(value);
        builder.finish()
    }
}

/// A [`Shape`] under construction, with an index for merging keys quickly.
#[derive(Default)]
struct ShapeBuilder {
    keys: Vec<(String, ShapeBuilder)>,
    index: HashMap<String, usize>,
    items: Option<Box<ShapeBuilder>>,
}

impl ShapeBuilder {
    /// Merges `value` in. Recursion is bounded by the parser's nesting limit.
    fn add(&mut self, value: &Value) {
        match value {
            Value::Object(members) => {
                for (key, v) in members {
                    let at = match self.index.get(key) {
                        Some(&at) => at,
                        None if self.keys.len() < MAX_SHAPE_KEYS => {
                            self.index.insert(key.clone(), self.keys.len());
                            self.keys.push((key.clone(), ShapeBuilder::default()));
                            self.keys.len() - 1
                        }
                        None => continue,
                    };
                    self.keys[at].1.add(v);
                }
            }
            Value::Array(elements) => {
                let items = self.items.get_or_insert_with(Default::default);
                for v in elements {
                    items.add(v);
                }
            }
            _ => {}
        }
    }

    fn finish(self) -> Shape {
        Shape {
            keys: self.keys.into_iter().map(|(k, b)| (k, b.finish())).collect(),
            items: self.items.map(|b| Box::new(b.finish())),
        }
    }
}

/// The byte range in `text` of the value at each of `locations`, in the same
/// order, found in one pass over the text. `text` must be valid JSON (it
/// parsed), and every location must exist in it (the query found it there).
fn source_spans(text: &str, locations: &[&NormalizedPath]) -> Vec<Range<usize>> {
    let mut wanted = Trie::default();
    for (i, location) in locations.iter().enumerate() {
        let mut node = &mut wanted;
        for element in location.iter() {
            node = match element {
                PathElement::Name(name) => node.names.entry((*name).to_owned()).or_default(),
                PathElement::Index(index) => node.indices.entry(*index).or_default(),
            };
        }
        node.matches.push(i);
    }
    let mut spans = vec![0..0; locations.len()];
    let mut s = Scanner { bytes: text.as_bytes(), pos: 0 };
    s.skip_ws();
    s.visit(&wanted, &mut spans);
    spans
}

/// The match locations as a tree: which members and elements to descend
/// into, and which matches end at this node.
#[derive(Default)]
struct Trie {
    matches: Vec<usize>,
    names: HashMap<String, Trie>,
    indices: HashMap<usize, Trie>,
}

/// Walks already-validated JSON, descending only where a match lies.
struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Scanner<'_> {
    fn peek(&self) -> u8 {
        self.bytes.get(self.pos).copied().unwrap_or(0)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), b' ' | b'\t' | b'\n' | b'\r') {
            self.pos += 1;
        }
    }

    /// Visits the value at the cursor, recording its span for the matches
    /// that end here. Recursion is bounded by the parser's nesting limit.
    fn visit(&mut self, node: &Trie, spans: &mut [Range<usize>]) {
        let start = self.pos;
        let descend = !node.names.is_empty() || !node.indices.is_empty();
        match self.peek() {
            b'{' if descend => {
                self.pos += 1;
                self.skip_ws();
                while self.peek() == b'"' {
                    let key = self.key();
                    self.skip_ws();
                    self.pos += 1; // ':'
                    self.skip_ws();
                    match node.names.get(&key) {
                        Some(child) => self.visit(child, spans),
                        None => self.skip_value(),
                    }
                    self.skip_ws();
                    if self.peek() == b',' {
                        self.pos += 1;
                        self.skip_ws();
                    }
                }
                self.pos += 1; // '}'
            }
            b'[' if descend => {
                self.pos += 1;
                self.skip_ws();
                let mut index = 0;
                while self.peek() != b']' {
                    match node.indices.get(&index) {
                        Some(child) => self.visit(child, spans),
                        None => self.skip_value(),
                    }
                    index += 1;
                    self.skip_ws();
                    if self.peek() == b',' {
                        self.pos += 1;
                        self.skip_ws();
                    }
                }
                self.pos += 1; // ']'
            }
            _ => self.skip_value(),
        }
        // A repeated key overwrites the earlier span: the parsed value kept
        // the last one too.
        for &m in &node.matches {
            spans[m] = start..self.pos;
        }
    }

    /// An object key, unescaped (the query's locations hold decoded names).
    fn key(&mut self) -> String {
        let start = self.pos;
        self.skip_string();
        let raw = &self.bytes[start..self.pos];
        let raw = std::str::from_utf8(raw).unwrap_or_default();
        if raw.contains('\\') {
            serde_json::from_str(raw).unwrap_or_default()
        } else {
            raw[1..raw.len() - 1].to_owned()
        }
    }

    fn skip_string(&mut self) {
        self.pos += 1; // opening quote
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    return;
                }
                _ => self.pos += 1,
            }
        }
    }

    /// Moves past one value of any kind.
    fn skip_value(&mut self) {
        let mut depth = 0usize;
        loop {
            match self.peek() {
                b'"' => self.skip_string(),
                b'{' | b'[' => {
                    depth += 1;
                    self.pos += 1;
                }
                b'}' | b']' => {
                    depth -= 1;
                    self.pos += 1;
                }
                0 => return,
                _ if depth == 0 => {
                    // A scalar: runs until a delimiter.
                    while !matches!(self.peek(), b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r' | 0) {
                        self.pos += 1;
                    }
                    return;
                }
                _ => self.pos += 1,
            }
            if depth == 0 {
                return;
            }
        }
    }
}
