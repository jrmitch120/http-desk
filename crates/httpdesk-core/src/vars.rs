//! `{{variable}}` substitution, including the common dynamic variables of the
//! JetBrains HTTP Client (`$uuid`, `$timestamp`, `$random.integer()`, …) and
//! VS Code REST Client (`$guid`, `$randomInt`, `$datetime`, `$processEnv`, …).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::{Duration, Local, Utc};

use crate::model::Variable;

const MAX_DEPTH: usize = 10;

/// Resolves `{{name}}` references against a flat variable map.
#[derive(Debug, Default)]
pub struct Resolver {
    vars: HashMap<String, String>,
    base_dir: Option<PathBuf>,
    unresolved: std::cell::RefCell<BTreeSet<String>>,
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

    pub fn resolve(&self, text: &str) -> String {
        self.resolve_depth(text, 0)
    }

    /// Variable names that could not be resolved so far.
    pub fn unresolved(&self) -> Vec<String> {
        self.unresolved.borrow().iter().cloned().collect()
    }

    fn resolve_depth(&self, text: &str, depth: usize) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("{{") {
            let Some(len) = rest[start + 2..].find("}}") else { break };
            out.push_str(&rest[..start]);
            let inner = rest[start + 2..start + 2 + len].trim();
            let whole = &rest[start..start + 4 + len];
            rest = &rest[start + 4 + len..];

            let value = if let Some(dynamic) = inner.strip_prefix('$') {
                self.dynamic(dynamic)
            } else if depth < MAX_DEPTH {
                self.vars.get(inner).map(|v| self.resolve_depth(v, depth + 1))
            } else {
                None
            };
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    self.unresolved.borrow_mut().insert(inner.to_string());
                    out.push_str(whole);
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn dynamic(&self, expr: &str) -> Option<String> {
        let (name, args) = split_call(expr);
        let arg = |i: usize| args.get(i).map(String::as_str);
        let num = |i: usize, default: i64| arg(i).and_then(|a| a.parse::<i64>().ok()).unwrap_or(default);
        Some(match name {
            "uuid" | "guid" | "random.uuid" => uuid::Uuid::new_v4().to_string(),
            "timestamp" => (Utc::now() + offset(&args)).timestamp().to_string(),
            "isoTimestamp" => Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "randomInt" | "random.integer" => {
                let (lo, hi) = (num(0, 0), num(1, 1000));
                rand::random_range(lo..hi.max(lo + 1)).to_string()
            }
            "random.float" => {
                let (lo, hi) = (num(0, 0) as f64, num(1, 1000) as f64);
                format!("{:.4}", lo + rand::random::<f64>() * (hi - lo))
            }
            "random.alphabetic" | "random.alphanumeric" | "random.hexadecimal" => {
                let chars: &[u8] = match name {
                    "random.alphabetic" => b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                    "random.hexadecimal" => b"0123456789abcdef",
                    _ => b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
                };
                (0..num(0, 10).clamp(0, 4096)).map(|_| chars[rand::random_range(0..chars.len())] as char).collect()
            }
            "random.email" => format!("user{}@example.com", rand::random_range(1000..99999)),
            "datetime" | "localDatetime" => {
                let fmt = arg(0).unwrap_or("iso8601").trim_matches(['"', '\'']);
                let off = offset(&args[args.len().min(1)..]);
                if name == "localDatetime" {
                    format_datetime(Local::now() + off, fmt)
                } else {
                    format_datetime(Utc::now() + off, fmt)
                }
            }
            "processEnv" => std::env::var(arg(0)?.trim_start_matches('%')).ok()?,
            "dotenv" => self.dotenv(arg(0)?)?,
            _ => std::env::var(name.strip_prefix("env.")?).ok()?,
        })
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
    let mut parts = expr.split_whitespace();
    let name = parts.next().unwrap_or("");
    (name, parts.map(str::to_string).collect())
}

/// VS Code offset arguments: `-1 d`, `2 h`, …
fn offset(args: &[String]) -> Duration {
    let (Some(n), Some(unit)) = (args.first().and_then(|a| a.parse::<i64>().ok()), args.get(1)) else {
        return Duration::zero();
    };
    match unit.as_str() {
        "y" => Duration::days(365 * n),
        "M" => Duration::days(30 * n),
        "w" => Duration::weeks(n),
        "d" => Duration::days(n),
        "h" => Duration::hours(n),
        "m" => Duration::minutes(n),
        "s" => Duration::seconds(n),
        "ms" => Duration::milliseconds(n),
        _ => Duration::zero(),
    }
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

/// Converts a Day.js-style pattern (`YYYY-MM-DD HH:mm:ss`) to strftime.
fn convert_format(f: &str) -> String {
    [("YYYY", "%Y"), ("MM", "%m"), ("DD", "%d"), ("HH", "%H"), ("mm", "%M"), ("ss", "%S")]
        .iter()
        .fold(f.to_string(), |acc, (from, to)| acc.replace(from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn cycles_terminate() {
        let r = resolver(&[("a", "{{b}}"), ("b", "{{a}}")]);
        let out = r.resolve("{{a}}");
        assert!(out.contains("{{"));
    }

    #[test]
    fn precedence_request_over_file_over_env() {
        let env: HashMap<_, _> = [("x".to_string(), "env".to_string()), ("y".into(), "env".into()), ("z".into(), "env".into())].into();
        let file = [Variable { name: "y".into(), value: "file".into() }, Variable { name: "z".into(), value: "file".into() }];
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
}
