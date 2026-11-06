//! `$ref` handling: JSON pointers and inlining of relative-file external refs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Resolves a JSON pointer fragment (the part after `#`), percent-decoding it.
pub(crate) fn json_pointer<'a>(root: &'a Value, fragment: &str) -> Option<&'a Value> {
    let decoded = percent_decode(fragment);
    if decoded.is_empty() || decoded == "/" {
        return Some(root);
    }
    root.pointer(&decoded)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct Bundler {
    base_dir: Option<PathBuf>,
    cache: HashMap<PathBuf, Option<Value>>,
    warnings: Vec<String>,
}

/// Inlines external (`other.yaml#/Pet`) refs. Local refs of the root document
/// are left for lazy resolution; local refs *inside* external files are
/// inlined since they point into that file.
pub(crate) fn bundle_external(root: &mut Value, base_dir: Option<PathBuf>, warnings: &mut Vec<String>) {
    let mut b = Bundler { base_dir, cache: HashMap::new(), warnings: Vec::new() };
    let mut stack = Vec::new();
    b.walk(root, None, &mut stack, 0);
    for w in b.warnings {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    }
}

impl Bundler {
    fn load(&mut self, path: &Path) -> Option<Value> {
        if let Some(v) = self.cache.get(path) {
            return v.clone();
        }
        let loaded = std::fs::read_to_string(path)
            .map_err(|e| e.to_string())
            .and_then(|t| super::parse_value(&t, super::has_json_extension(path)));
        let value = match loaded {
            Ok(v) => Some(v),
            Err(e) => {
                self.warnings.push(format!("Could not load external reference {}: {e}", path.display()));
                None
            }
        };
        self.cache.insert(path.to_path_buf(), value.clone());
        value
    }

    /// `file`: the external file the current value came from (None = root doc).
    fn walk(&mut self, v: &mut Value, file: Option<&Path>, stack: &mut Vec<(PathBuf, String)>, depth: usize) {
        if depth > 64 {
            return;
        }
        match v {
            Value::Object(map) => {
                if let Some(r) = map.get("$ref").and_then(Value::as_str).map(str::to_string) {
                    if let Some(replacement) = self.resolve_ref(&r, file, stack, depth) {
                        *v = replacement;
                    }
                    return;
                }
                for child in map.values_mut() {
                    self.walk(child, file, stack, depth + 1);
                }
            }
            Value::Array(items) => {
                for child in items {
                    self.walk(child, file, stack, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn resolve_ref(
        &mut self,
        r: &str,
        file: Option<&Path>,
        stack: &mut Vec<(PathBuf, String)>,
        depth: usize,
    ) -> Option<Value> {
        let (file_part, fragment) = match r.split_once('#') {
            Some((f, frag)) => (f, frag),
            None => (r, ""),
        };
        if file_part.is_empty() && file.is_none() {
            return None; // local ref in the root document: resolved lazily
        }
        if file_part.starts_with("http://") || file_part.starts_with("https://") {
            self.warnings.push(format!("Remote reference {r} is not resolved"));
            return None;
        }
        let target_file: PathBuf = if file_part.is_empty() {
            file?.to_path_buf()
        } else {
            let dir = match file {
                Some(f) => f.parent().map(Path::to_path_buf),
                None => self.base_dir.clone(),
            };
            let Some(dir) = dir else {
                self.warnings.push(format!("External reference {r} is not resolved (no local base directory)"));
                return None;
            };
            dir.join(file_part)
        };
        let key = (target_file.clone(), fragment.to_string());
        if stack.contains(&key) {
            self.warnings.push(format!("Circular external reference {r} was truncated"));
            return Some(Value::Object(Default::default()));
        }
        let doc = self.load(&target_file)?;
        let Some(target) = json_pointer(&doc, fragment).cloned() else {
            self.warnings.push(format!("Unresolved external reference {r}"));
            return None;
        };
        let mut target = target;
        stack.push(key);
        self.walk(&mut target, Some(&target_file), stack, depth + 1);
        stack.pop();
        Some(target)
    }
}
