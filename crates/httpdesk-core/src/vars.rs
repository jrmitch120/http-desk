//! `{{variable}}` substitution, including the common dynamic variables of the
//! JetBrains HTTP Client (`$uuid`, `$timestamp`, `$random.integer()`, …) and
//! VS Code REST Client (`$guid`, `$randomInt`, `$datetime`, `$processEnv`, …).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::{Duration, Local, Utc};

use crate::model::{Prompt, Variable};

/// Every dynamic variable the resolver generates, without the `$`; `env.` takes a
/// name after it. Anything else after `$` is an Undefined variable. Autocomplete's
/// list (`dynamic-variables.json`, with descriptions and argument hints) must name
/// exactly these, in this order: a test checks.
pub const DYNAMIC_VARIABLES: &[&str] = &[
    "uuid",
    "guid",
    "random.uuid",
    "timestamp",
    "isoTimestamp",
    "randomInt",
    "random.integer",
    "random.float",
    "random.alphabetic",
    "random.alphanumeric",
    "random.hexadecimal",
    "random.email",
    "datetime",
    "localDatetime",
    "processEnv",
    "dotenv",
    "env.",
];

fn is_dynamic(name: &str) -> bool {
    DYNAMIC_VARIABLES.iter().any(|d| {
        if d.ends_with('.') {
            name.len() > d.len() && name.starts_with(d)
        } else {
            name == *d
        }
    })
}

/// A run of plain text, or one `{{…}}` reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Segment<'a> {
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
pub(crate) fn segments(text: &str) -> Vec<Segment<'_>> {
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

/// Dynamic variables that generate a new value on every send. The others
/// (`$processEnv`, `$dotenv`, `$env.X`) read a value that's already there.
const GENERATED: &[&str] = &[
    "uuid",
    "guid",
    "random.uuid",
    "timestamp",
    "isoTimestamp",
    "randomInt",
    "random.integer",
    "random.float",
    "random.alphabetic",
    "random.alphanumeric",
    "random.hexadecimal",
    "random.email",
    "datetime",
    "localDatetime",
];

/// Brackets the index of a placeholder (see [`Resolver::previewing`]). Private-use
/// characters, so they can't clash with real text and survive query encoding.
const PLACEHOLDER: (char, char) = ('\u{E000}', '\u{E001}');

/// How the resolved preview shows a masked prompted value.
pub const MASK: &str = "••••••••";

/// Resolves `{{name}}` references against a flat variable map.
#[derive(Debug, Default)]
pub struct Resolver {
    vars: HashMap<String, String>,
    base_dir: Option<PathBuf>,
    unresolved: std::cell::RefCell<BTreeSet<String>>,
    circular: std::cell::RefCell<Vec<Vec<String>>>,
    errors: std::cell::RefCell<Vec<String>>,
    /// Set by [`Resolver::previewing`]: generated dynamic variables, as written.
    placeholders: Option<std::cell::RefCell<Vec<String>>>,
    /// Prompt variables (see [`Resolver::with_prompts`]): answered ones with their
    /// value and whether it's masked, unanswered ones with `None`.
    prompts: HashMap<String, Option<(String, bool)>>,
    unanswered: std::cell::RefCell<BTreeSet<String>>,
}

impl Resolver {
    pub fn new(vars: HashMap<String, String>) -> Self {
        Resolver { vars, ..Default::default() }
    }

    /// Builds the scope with precedence: request vars > file vars > environment.
    pub fn for_request(
        env: &HashMap<String, String>,
        file_vars: &[Variable],
        request_vars: &[Variable],
        base_dir: Option<&Path>,
    ) -> Self {
        let mut vars = env.clone();
        for v in file_vars.iter().chain(request_vars) {
            vars.insert(v.name.clone(), v.value.clone());
        }
        Resolver { vars, base_dir: base_dir.map(Path::to_path_buf), ..Default::default() }
    }

    /// Adds the request's Prompt variables. An answered one (its value in `answers`)
    /// overrides every other variable of the same name, also inside other variables'
    /// values, and is used as typed. An unanswered one is left as written and
    /// reported by [`Self::unanswered`], not as undefined.
    pub fn with_prompts(mut self, prompts: &[Prompt], answers: &HashMap<String, String>) -> Self {
        for p in prompts {
            let answer = answers.get(&p.name).map(|v| (v.clone(), p.masked()));
            self.prompts.insert(p.name.clone(), answer);
        }
        self
    }

    /// For the resolved preview: dynamic variables that would generate a new value
    /// on every send (`$uuid`, `$timestamp`, `$random…`) are not generated. They
    /// resolve to placeholders that [`Resolver::replace_placeholders`] turns back
    /// into the reference as written, wherever they end up (even percent-encoded).
    pub fn previewing(mut self) -> Self {
        self.placeholders = Some(Default::default());
        self
    }

    /// `text` with each placeholder replaced by `with(reference as written)`.
    pub fn replace_placeholders(&self, text: &str, with: impl Fn(&str) -> String) -> String {
        let Some(placeholders) = &self.placeholders else { return text.to_string() };
        let (open, close) = PLACEHOLDER;
        let encoded = |c: char| c.encode_utf8(&mut [0; 4]).bytes().map(|b| format!("%{b:02X}")).collect::<String>();
        let mut out = text.to_string();
        for (i, whole) in placeholders.borrow().iter().enumerate() {
            let value = with(whole);
            out = out.replace(&format!("{open}{i}{close}"), &value);
            out = out.replace(&format!("{}{i}{}", encoded(open), encoded(close)), &value);
        }
        out
    }

    /// Whether `text` holds a placeholder.
    pub fn has_placeholders(&self, text: &str) -> bool {
        self.placeholders.is_some() && text.contains(PLACEHOLDER.0)
    }

    fn placeholder(&self, whole: &str) -> Option<String> {
        let mut placeholders = self.placeholders.as_ref()?.borrow_mut();
        let i = placeholders.iter().position(|p| p == whole).unwrap_or_else(|| {
            placeholders.push(whole.to_string());
            placeholders.len() - 1
        });
        let (open, close) = PLACEHOLDER;
        Some(format!("{open}{i}{close}"))
    }

    pub fn resolve(&self, text: &str) -> String {
        self.resolve_chain(text, &mut Vec::new())
    }

    /// Undefined variables met so far: names with no definition in scope. Circular
    /// references are reported by [`Self::circular`] instead.
    pub fn unresolved(&self) -> Vec<String> {
        self.unresolved.borrow().iter().cloned().collect()
    }

    /// Unanswered Prompt variables met so far: asked when the request is sent.
    pub fn unanswered(&self) -> Vec<String> {
        self.unanswered.borrow().iter().cloned().collect()
    }

    /// Circular references met so far, each as the chain of names followed from the
    /// reference as written to the name that repeats (`["a", "b", "a"]`), in the order found.
    pub fn circular(&self) -> Vec<Vec<String>> {
        self.circular.borrow().clone()
    }

    /// Dynamic variables that failed (bad or out-of-range arguments), as messages.
    pub fn errors(&self) -> Vec<String> {
        self.errors.borrow().clone()
    }

    /// Resolves `text`, where `chain` is the names being resolved around it. A name
    /// already on the chain is a circular reference: it's recorded and left as written.
    fn resolve_chain(&self, text: &str, chain: &mut Vec<String>) -> String {
        let mut out = String::with_capacity(text.len());
        for segment in segments(text) {
            let (whole, inner) = match segment {
                Segment::Text(s) => {
                    out.push_str(s);
                    continue;
                }
                Segment::Reference { whole, name } => (whole, name),
            };
            let value = if let Some(dynamic) = inner.strip_prefix('$') {
                if GENERATED.contains(&split_call(dynamic).0) {
                    if let Some(placeholder) = self.placeholder(whole) {
                        out.push_str(&placeholder);
                        continue;
                    }
                }
                match self.dynamic(dynamic) {
                    Ok(v) => v,
                    Err(e) => {
                        let (name, _) = split_call(dynamic);
                        let e = format!("{{{{${dynamic}}}}}: ${name} {e}");
                        let mut errors = self.errors.borrow_mut();
                        if !errors.contains(&e) {
                            errors.push(e);
                        }
                        out.push_str(whole);
                        continue;
                    }
                }
            } else if let Some(prompt) = self.prompts.get(inner) {
                // In the preview a masked value is shown masked, and an unanswered
                // prompt as written (a placeholder, so it passes the URL check).
                let shown = match prompt {
                    Some((value, masked)) => {
                        (*masked).then(|| self.placeholder(MASK)).flatten().unwrap_or(value.clone())
                    }
                    None => {
                        self.unanswered.borrow_mut().insert(inner.to_string());
                        self.placeholder(whole).unwrap_or_else(|| whole.to_string())
                    }
                };
                out.push_str(&shown);
                continue;
            } else if chain.iter().any(|n| n == inner) {
                let mut cycle = chain.clone();
                cycle.push(inner.to_string());
                let mut circular = self.circular.borrow_mut();
                if !circular.contains(&cycle) {
                    circular.push(cycle);
                }
                out.push_str(whole);
                continue;
            } else {
                self.vars.get(inner).map(|v| {
                    chain.push(inner.to_string());
                    let resolved = self.resolve_chain(v, chain);
                    chain.pop();
                    resolved
                })
            };
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    self.unresolved.borrow_mut().insert(inner.to_string());
                    out.push_str(whole);
                }
            }
        }
        out
    }

    /// `Ok(None)` when the variable is unknown or unset; `Err` when its arguments are bad.
    fn dynamic(&self, expr: &str) -> Result<Option<String>, String> {
        let (name, args) = split_call(expr);
        if !is_dynamic(name) {
            return Ok(None);
        }
        let arg = |i: usize| args.get(i).map(String::as_str);
        let int = |i: usize, default: i64| arg(i).map_or(Ok(default), parse_int);
        Ok(Some(match name {
            "uuid" | "guid" | "random.uuid" => uuid::Uuid::new_v4().to_string(),
            "timestamp" => shift(Utc::now(), offset(&args)?)?.timestamp().to_string(),
            "isoTimestamp" => Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "randomInt" | "random.integer" => {
                let (lo, hi) = (int(0, 0)?, int(1, 1000)?);
                if lo >= hi {
                    return Err(format!("needs min < max (max is exclusive), got {lo} and {hi}"));
                }
                rand::random_range(lo..hi).to_string()
            }
            "random.float" => {
                let float = |i: usize, default: f64| {
                    arg(i).map_or(Ok(default), |a| {
                        a.parse::<f64>()
                            .ok()
                            .filter(|f| f.is_finite())
                            .ok_or_else(|| format!("\"{a}\" is not a number"))
                    })
                };
                let (lo, hi) = (float(0, 0.0)?, float(1, 1000.0)?);
                if lo > hi {
                    return Err(format!("needs min <= max, got {lo} and {hi}"));
                }
                format!("{:.4}", lo + rand::random::<f64>() * (hi - lo))
            }
            "random.alphabetic" | "random.alphanumeric" | "random.hexadecimal" => {
                let chars: &[u8] = match name {
                    "random.alphabetic" => b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                    "random.hexadecimal" => b"0123456789abcdef",
                    _ => b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
                };
                (0..int(0, 10)?.clamp(0, 4096)).map(|_| chars[rand::random_range(0..chars.len())] as char).collect()
            }
            "random.email" => format!("user{}@example.com", rand::random_range(1000..99999)),
            "datetime" | "localDatetime" => {
                let fmt = arg(0).unwrap_or("iso8601").trim_matches(['"', '\'']);
                let off = offset(&args[args.len().min(1)..])?;
                if name == "localDatetime" {
                    format_datetime(shift(Local::now(), off)?, fmt)
                } else {
                    format_datetime(shift(Utc::now(), off)?, fmt)
                }
            }
            "processEnv" => {
                let Some(key) = arg(0) else { return Ok(None) };
                return Ok(std::env::var(key.trim_start_matches('%')).ok());
            }
            "dotenv" => return Ok(arg(0).and_then(|k| self.dotenv(k))),
            _ => return Ok(name.strip_prefix("env.").and_then(|k| std::env::var(k).ok())),
        }))
    }

    fn dotenv(&self, key: &str) -> Option<String> {
        let dir = self.base_dir.as_ref()?;
        let text = std::fs::read_to_string(dir.join(".env")).ok()?;
        text.lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            (k.trim() == key).then(|| v.trim().trim_matches('"').to_string())
        })
    }
}

/// Splits `name arg1 arg2` (VS Code) or `name(arg1, arg2)` (JetBrains).
fn split_call(expr: &str) -> (&str, Vec<String>) {
    if let Some(open) = expr.find('(') {
        let name = &expr[..open];
        let inner = expr[open + 1..].trim_end().trim_end_matches(')');
        let args = inner.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();
        return (name, args);
    }
    let expr = expr.trim();
    let (name, rest) = expr.split_once(char::is_whitespace).unwrap_or((expr, ""));
    (name, split_args(rest))
}

/// Whitespace-separated arguments; `"…"` and `'…'` group words and lose their quotes.
fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut chars = text.trim().chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let mut arg = String::new();
        if c == '"' || c == '\'' {
            chars.next();
            arg.extend(chars.by_ref().take_while(|&ch| ch != c));
        } else {
            while let Some(ch) = chars.next_if(|ch| !ch.is_whitespace()) {
                arg.push(ch);
            }
        }
        args.push(arg);
    }
    args
}

fn parse_int(a: &str) -> Result<i64, String> {
    a.parse::<i64>().map_err(|_| format!("\"{a}\" is not a whole number between {} and {}", i64::MIN, i64::MAX))
}

/// VS Code offset arguments: `-1 d`, `2 h`, … (none means no offset).
fn offset(args: &[String]) -> Result<Duration, String> {
    let (n, unit) = match args {
        [] => return Ok(Duration::zero()),
        [n, unit] => (parse_int(n)?, unit.as_str()),
        _ => return Err(format!("expects an offset like `-1 d`, got `{}`", args.join(" "))),
    };
    let scaled = |factor: i64, f: fn(i64) -> Option<Duration>| n.checked_mul(factor).and_then(f);
    let d = match unit {
        "y" => scaled(365, Duration::try_days),
        "M" => scaled(30, Duration::try_days),
        "w" => Duration::try_weeks(n),
        "d" => Duration::try_days(n),
        "h" => Duration::try_hours(n),
        "m" => Duration::try_minutes(n),
        "s" => Duration::try_seconds(n),
        "ms" => Duration::try_milliseconds(n),
        _ => return Err(format!("has an unknown offset unit \"{unit}\" (use y, M, w, d, h, m, s or ms)")),
    };
    d.ok_or_else(|| format!("offset {n} {unit} is out of range"))
}

fn shift<Tz: chrono::TimeZone>(dt: chrono::DateTime<Tz>, by: Duration) -> Result<chrono::DateTime<Tz>, String> {
    dt.checked_add_signed(by).ok_or_else(|| "offset moves the date out of range".to_string())
}

fn format_datetime<Tz: chrono::TimeZone>(dt: chrono::DateTime<Tz>, fmt: &str) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match fmt {
        "rfc1123" => dt.with_timezone(&Utc).format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        "iso8601" => dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        custom => dt.format(&convert_format(custom)).to_string(),
    }
}

/// Day.js tokens and their strftime equivalents, longest first so `MMMM` wins over `MM`.
const DAYJS_TOKENS: &[(&str, &str)] = &[
    ("YYYY", "%Y"),
    ("MMMM", "%B"),
    ("dddd", "%A"),
    ("MMM", "%b"),
    ("ddd", "%a"),
    ("SSS", "%3f"),
    ("YY", "%y"),
    ("MM", "%m"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("hh", "%I"),
    ("mm", "%M"),
    ("ss", "%S"),
    ("ZZ", "%z"),
    ("M", "%-m"),
    ("D", "%-d"),
    ("H", "%-H"),
    ("h", "%-I"),
    ("m", "%-M"),
    ("s", "%-S"),
    ("A", "%p"),
    ("a", "%P"),
    ("Z", "%:z"),
];

/// Converts a Day.js pattern (`YYYY-MM-DD hh:mm A`) to strftime. Everything that
/// isn't a token, and anything in `[brackets]`, is literal, so the result is
/// always a valid strftime pattern.
fn convert_format(f: &str) -> String {
    let mut out = String::with_capacity(f.len() * 2);
    let literal = |out: &mut String, text: &str| out.push_str(&text.replace('%', "%%"));
    let mut rest = f;
    while let Some(c) = rest.chars().next() {
        if c == '[' {
            if let Some(end) = rest.find(']') {
                literal(&mut out, &rest[1..end]);
                rest = &rest[end + 1..];
                continue;
            }
        }
        if let Some((token, strftime)) = DAYJS_TOKENS.iter().find(|(t, _)| rest.starts_with(t)) {
            out.push_str(strftime);
            rest = &rest[token.len()..];
        } else {
            literal(&mut out, &rest[..c.len_utf8()]);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn resolver(pairs: &[(&str, &str)]) -> Resolver {
        Resolver::new(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn resolves_nested_and_reports_unresolved() {
        let r = resolver(&[("host", "example.com"), ("base", "https://{{host}}/api")]);
        assert_eq!(r.resolve("{{base}}/users/{{ id }}"), "https://example.com/api/users/{{ id }}");
        assert_eq!(r.unresolved(), vec!["id"]);
    }

    #[test]
    fn a_cycle_is_reported_as_circular_with_its_chain_not_as_undefined() {
        let r = resolver(&[("a", "{{b}}"), ("b", "{{a}}")]);
        assert_eq!(r.resolve("{{a}}"), "{{a}}");
        assert_eq!(r.circular(), vec![vec!["a", "b", "a"]]);
        assert!(r.unresolved().is_empty(), "{:?}", r.unresolved());
    }

    #[test]
    fn the_chain_starts_at_the_reference_and_a_self_reference_is_circular() {
        let r = resolver(&[("url", "https://{{a}}/x"), ("a", "{{b}}"), ("b", "{{a}}"), ("me", "{{me}}")]);
        assert_eq!(r.resolve("{{url}} {{me}}"), "https://{{a}}/x {{me}}");
        assert_eq!(r.circular(), vec![vec!["url", "a", "b", "a"], vec!["me", "me"]]);
        assert!(r.unresolved().is_empty(), "{:?}", r.unresolved());
    }

    #[test]
    fn a_long_chain_without_a_cycle_resolves() {
        let pairs: Vec<(String, String)> = (0..15).map(|i| (format!("v{i}"), format!("{{{{v{}}}}}", i + 1))).collect();
        let mut map: HashMap<String, String> = pairs.into_iter().collect();
        map.insert("v15".into(), "end".into());
        let r = Resolver::new(map);
        assert_eq!(r.resolve("{{v0}}"), "end");
        assert!(r.circular().is_empty() && r.unresolved().is_empty());
    }

    #[test]
    fn a_name_used_twice_side_by_side_is_not_circular() {
        let r = resolver(&[("host", "h"), ("both", "{{host}}{{host}}")]);
        assert_eq!(r.resolve("{{both}}"), "hh");
        assert!(r.circular().is_empty());
    }

    #[test]
    fn precedence_request_over_file_over_env() {
        let env: HashMap<_, _> =
            [("x".to_string(), "env".to_string()), ("y".into(), "env".into()), ("z".into(), "env".into())].into();
        let file =
            [Variable { name: "y".into(), value: "file".into() }, Variable { name: "z".into(), value: "file".into() }];
        let req = [Variable { name: "z".into(), value: "req".into() }];
        let r = Resolver::for_request(&env, &file, &req, None);
        assert_eq!(r.resolve("{{x}} {{y}} {{z}}"), "env file req");
    }

    #[test]
    fn dynamic_variables() {
        let r = resolver(&[]);
        assert_eq!(r.resolve("{{$uuid}}").len(), 36);
        assert_eq!(r.resolve("{{$random.uuid}}").len(), 36);
        assert!(r.resolve("{{$timestamp}}").parse::<i64>().unwrap() > 1_600_000_000);
        let n: i64 = r.resolve("{{$randomInt 5 6}}").parse().unwrap();
        assert_eq!(n, 5);
        let n: i64 = r.resolve("{{$random.integer(10, 11)}}").parse().unwrap();
        assert_eq!(n, 10);
        assert!(r.resolve("{{$datetime rfc1123}}").ends_with("GMT"));
        assert!(r.resolve("{{$isoTimestamp}}").ends_with('Z'));
        assert_eq!(r.resolve("{{$random.hexadecimal(8)}}").len(), 8);
        assert!(r.unresolved().is_empty());
        std::env::set_var("HTTPDESK_TEST_VAR", "yes");
        assert_eq!(r.resolve("{{$processEnv HTTPDESK_TEST_VAR}}"), "yes");
        assert_eq!(r.resolve("{{$env.HTTPDESK_TEST_VAR}}"), "yes");
    }

    /// Autocomplete offers the dynamic variables listed in `dynamic-variables.json`.
    /// The resolver generates nothing outside `DYNAMIC_VARIABLES`, so a dynamic
    /// variable added to the core without its entry there fails here.
    #[test]
    fn autocomplete_lists_every_dynamic_variable() {
        #[derive(serde::Deserialize)]
        struct Catalogue {
            variables: Vec<Entry>,
        }
        #[derive(serde::Deserialize)]
        struct Entry {
            name: String,
        }
        let listed: Catalogue = serde_json::from_str(include_str!("../dynamic-variables.json")).unwrap();
        let listed: Vec<String> = listed.variables.into_iter().map(|e| e.name).collect();
        let generated: Vec<String> = DYNAMIC_VARIABLES.iter().map(|n| format!("${n}")).collect();
        assert_eq!(listed, generated);
    }

    #[test]
    fn the_resolver_generates_every_listed_dynamic_variable_and_nothing_else() {
        std::env::set_var("HTTPDESK_LISTED_VAR", "yes");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "HTTPDESK_LISTED_VAR=yes\n").unwrap();
        let r = Resolver::for_request(&HashMap::new(), &[], &[], Some(dir.path()));
        for name in DYNAMIC_VARIABLES {
            let reference = match *name {
                "processEnv" | "dotenv" => format!("{{{{${name} HTTPDESK_LISTED_VAR}}}}"),
                "env." => "{{$env.HTTPDESK_LISTED_VAR}}".to_string(),
                _ => format!("{{{{${name}}}}}"),
            };
            assert!(!r.resolve(&reference).contains("{{"), "{reference} was not generated");
        }
        assert!(r.unresolved().is_empty() && r.errors().is_empty(), "{:?} {:?}", r.unresolved(), r.errors());
        assert_eq!(r.resolve("{{$nope}}"), "{{$nope}}");
        assert_eq!(r.unresolved(), vec!["$nope"]);
    }

    /// Resolves `text` with a fresh resolver and returns its errors.
    fn errors_of(text: &str) -> Vec<String> {
        let r = resolver(&[]);
        let out = r.resolve(text);
        assert_eq!(out, text, "a failed dynamic variable is left as written");
        r.errors()
    }

    #[test]
    fn dynamic_variables_with_bad_arguments_report_errors() {
        let cases = [
            ("{{$randomInt 9223372036854775807 9223372036854775807}}", "$randomInt"),
            ("{{$randomInt 99999999999999999999 1}}", "99999999999999999999"),
            ("{{$randomInt a 10}}", "\"a\""),
            ("{{$randomInt 10 5}}", "$randomInt"),
            ("{{$random.integer(5, 5)}}", "$random.integer"),
            ("{{$timestamp 9223372036854775807 y}}", "$timestamp"),
            ("{{$timestamp -9223372036854775808 ms}}", "$timestamp"),
            ("{{$timestamp 1 fortnight}}", "fortnight"),
            ("{{$timestamp x d}}", "\"x\""),
            ("{{$timestamp 1}}", "$timestamp"),
            ("{{$datetime iso8601 9223372036854775807 d}}", "$datetime"),
            ("{{$localDatetime rfc1123 300000 y}}", "$localDatetime"),
        ];
        for (text, mentions) in cases {
            let errors = errors_of(text);
            assert_eq!(errors.len(), 1, "{text}: {errors:?}");
            assert!(errors[0].contains(mentions), "{text}: {errors:?}");
        }
    }

    fn matches_shape(value: &str, shape: &str) {
        let ok = value.len() == shape.len()
            && value.chars().zip(shape.chars()).all(|(v, s)| if s == '9' { v.is_ascii_digit() } else { v == s });
        assert!(ok, "{value:?} does not look like {shape:?}");
    }

    #[test]
    fn quoted_datetime_formats_are_honoured_whole() {
        let r = resolver(&[]);
        matches_shape(&r.resolve(r#"{{$datetime "YYYY-MM-DD HH:mm"}}"#), "9999-99-99 99:99");
        matches_shape(&r.resolve("{{$datetime 'DD/MM/YYYY HH:mm:ss' -1 d}}"), "99/99/9999 99:99:99");
        matches_shape(&r.resolve(r#"{{$localDatetime "HH:mm" 2 h}}"#), "99:99");
        matches_shape(&r.resolve("{{$datetime YYYY}}"), "9999");
        assert_eq!(r.resolve(r#"{{$datetime "[at] 100%"}}"#), "at 100%", "brackets escape; `%` is literal");
        assert!(r.errors().is_empty(), "{:?}", r.errors());
    }

    #[test]
    fn datetime_supports_common_dayjs_tokens() {
        let utc = Utc.with_ymd_and_hms(2026, 3, 7, 15, 4, 5).unwrap() + Duration::milliseconds(89);
        assert_eq!(format_datetime(utc, "YYYY-MM-DD hh:mm:ss.SSS A Z"), "2026-03-07 03:04:05.089 PM +00:00");
        assert_eq!(format_datetime(utc, "YY M D H h m s a ZZ"), "26 3 7 15 3 4 5 pm +0000");
        assert_eq!(format_datetime(utc, "ddd dddd MMM MMMM"), "Sat Saturday Mar March");
        let ist = utc.with_timezone(&chrono::FixedOffset::east_opt(5 * 3600 + 1800).unwrap());
        assert_eq!(format_datetime(ist, "HH:mm Z"), "20:34 +05:30");
        assert_eq!(format_datetime(ist, "iso8601"), "2026-03-07T20:34:05+05:30");
    }

    #[test]
    fn valid_dynamic_offsets_still_resolve() {
        let r = resolver(&[]);
        let now: i64 = r.resolve("{{$timestamp}}").parse().unwrap();
        let earlier: i64 = r.resolve("{{$timestamp -1 h}}").parse().unwrap();
        assert!((now - earlier - 3600).abs() <= 1, "{now} {earlier}");
        assert!(r.resolve("{{$datetime iso8601 1 d}}").ends_with('Z'));
        assert!(r.errors().is_empty(), "{:?}", r.errors());
    }
}
