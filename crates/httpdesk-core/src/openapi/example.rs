//! Example values from OpenAPI schemas (3.0 and 3.1 / JSON Schema).

use std::cell::RefCell;

use serde_json::{Map, Value};

use super::refs::json_pointer;

const MAX_DEPTH: usize = 10;

/// Shared traversal context: the root document and collected warnings.
pub(crate) struct Ctx<'a> {
    pub root: &'a Value,
    pub warnings: RefCell<Vec<String>>,
}

impl<'a> Ctx<'a> {
    pub fn new(root: &'a Value) -> Self {
        Ctx { root, warnings: RefCell::new(Vec::new()) }
    }

    pub fn warn(&self, msg: String) {
        let mut w = self.warnings.borrow_mut();
        if !w.contains(&msg) {
            w.push(msg);
        }
    }

    /// Follows local `$ref` chains. Returns the target and the last ref string.
    pub fn resolve(&self, v: &'a Value) -> (&'a Value, Option<&'a str>) {
        let mut cur = v;
        let mut last = None;
        for _ in 0..32 {
            let Some(r) = cur.get("$ref").and_then(Value::as_str) else { break };
            match r.strip_prefix('#').and_then(|p| json_pointer(self.root, p)) {
                Some(t) => {
                    last = Some(r);
                    cur = t;
                }
                None => {
                    self.warn(format!("Unresolved reference {r}"));
                    break;
                }
            }
        }
        (cur, last)
    }

    pub fn deref(&self, v: &'a Value) -> &'a Value {
        self.resolve(v).0
    }

    /// Example for a schema. `None` means "omit" (a recursive reference).
    pub fn schema_example(&self, schema: &'a Value) -> Value {
        let mut stack = Vec::new();
        self.example(schema, 0, &mut stack).unwrap_or(Value::Null)
    }

    fn example(&self, schema: &'a Value, depth: usize, stack: &mut Vec<&'a str>) -> Option<Value> {
        let (schema, r) = self.resolve(schema);
        if let Some(r) = r {
            if stack.contains(&r) {
                return None;
            }
            stack.push(r);
            let out = self.example_inner(schema, depth, stack);
            stack.pop();
            return out;
        }
        self.example_inner(schema, depth, stack)
    }

    fn example_inner(&self, schema: &'a Value, depth: usize, stack: &mut Vec<&'a str>) -> Option<Value> {
        let Some(obj) = schema.as_object() else {
            return Some(Value::Null);
        };
        if let Some(v) = explicit_example(obj) {
            return Some(v);
        }
        if let Some(all) = obj.get("allOf").and_then(Value::as_array) {
            let mut merged = Map::new();
            let mut scalar = None;
            for sub in all {
                match self.example(sub, depth, stack) {
                    Some(Value::Object(m)) => merged.extend(m),
                    Some(Value::Null) | None => {}
                    Some(other) => scalar = Some(other),
                }
            }
            if obj.contains_key("properties") {
                if let Some(Value::Object(m)) = self.object_example(obj, depth, stack) {
                    merged.extend(m);
                }
            }
            return Some(if merged.is_empty() { scalar.unwrap_or(Value::Object(merged)) } else { Value::Object(merged) });
        }
        for key in ["oneOf", "anyOf"] {
            if let Some(variants) = obj.get(key).and_then(Value::as_array) {
                let pick = variants
                    .iter()
                    .find(|v| !is_null_schema(self.deref(v)))
                    .or_else(|| variants.first());
                if let Some(v) = pick {
                    let mut out = self.example(v, depth, stack);
                    // Sibling properties next to oneOf/anyOf are merged in.
                    if obj.contains_key("properties") {
                        if let (Some(Value::Object(m)), Some(Value::Object(extra))) =
                            (&mut out, self.object_example(obj, depth, stack))
                        {
                            m.extend(extra);
                        }
                    }
                    return out;
                }
            }
        }
        match schema_type(obj).as_deref() {
            Some("object") => self.object_example(obj, depth, stack),
            Some("array") => {
                if depth >= MAX_DEPTH {
                    return Some(Value::Array(vec![]));
                }
                let items = obj.get("items").or_else(|| obj.get("prefixItems").and_then(|p| p.get(0)));
                let item = items.and_then(|i| self.example(i, depth + 1, stack));
                Some(Value::Array(item.into_iter().collect()))
            }
            Some("string") => Some(Value::String(string_example(obj))),
            Some("integer") => Some(Value::from(number_example(obj).unwrap_or(1.0).round() as i64)),
            Some("number") => {
                let n = number_example(obj).unwrap_or(0.0);
                Some(if n.fract() == 0.0 { Value::from(n as i64) } else { Value::from(n) })
            }
            Some("boolean") => Some(Value::Bool(true)),
            Some("null") => Some(Value::Null),
            _ => Some(Value::Null),
        }
    }

    fn object_example(&self, obj: &'a Map<String, Value>, depth: usize, stack: &mut Vec<&'a str>) -> Option<Value> {
        let mut out = Map::new();
        if depth >= MAX_DEPTH {
            return Some(Value::Object(out));
        }
        if let Some(props) = obj.get("properties").and_then(Value::as_object) {
            for (name, prop) in props {
                let resolved = self.deref(prop);
                if resolved.get("readOnly").and_then(Value::as_bool) == Some(true)
                    || prop.get("readOnly").and_then(Value::as_bool) == Some(true)
                {
                    continue;
                }
                if let Some(v) = self.example(prop, depth + 1, stack) {
                    out.insert(name.clone(), v);
                }
            }
        }
        if out.is_empty() {
            if let Some(ap) = obj.get("additionalProperties").filter(|a| a.is_object()) {
                if let Some(v) = self.example(ap, depth + 1, stack) {
                    out.insert("key".into(), v);
                }
            }
        }
        Some(Value::Object(out))
    }

    /// The (resolved) property schemas of an object schema, merging `allOf`.
    pub fn properties(&self, schema: &'a Value) -> Vec<(&'a str, &'a Value)> {
        let mut out = Vec::new();
        self.collect_properties(schema, &mut out, 0);
        out
    }

    fn collect_properties(&self, schema: &'a Value, out: &mut Vec<(&'a str, &'a Value)>, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        let schema = self.deref(schema);
        for sub in schema.get("allOf").and_then(Value::as_array).into_iter().flatten() {
            self.collect_properties(sub, out, depth + 1);
        }
        if let Some(props) = schema.get("properties").and_then(Value::as_object) {
            for (k, v) in props {
                let v = self.deref(v);
                match out.iter_mut().find(|(n, _)| *n == k) {
                    Some(slot) => slot.1 = v,
                    None => out.push((k.as_str(), v)),
                }
            }
        }
    }
}

/// `example`, `examples[0]` (JSON Schema), `const`, `default`, `enum[0]`.
fn explicit_example(obj: &Map<String, Value>) -> Option<Value> {
    if let Some(v) = obj.get("example") {
        return Some(v.clone());
    }
    if let Some(v) = obj.get("examples").and_then(Value::as_array).and_then(|a| a.first()) {
        return Some(v.clone());
    }
    if let Some(v) = obj.get("const") {
        return Some(v.clone());
    }
    if let Some(v) = obj.get("default") {
        return Some(v.clone());
    }
    obj.get("enum").and_then(Value::as_array).and_then(|e| e.iter().find(|v| !v.is_null()).cloned())
}

fn is_null_schema(v: &Value) -> bool {
    match v.get("type") {
        Some(Value::String(t)) => t == "null",
        Some(Value::Array(a)) => a.iter().all(|t| t == "null"),
        _ => false,
    }
}

/// The schema type, picking the first non-null entry of 3.1 type arrays and
/// inferring from structure when absent.
pub(crate) fn schema_type(obj: &Map<String, Value>) -> Option<String> {
    match obj.get("type") {
        Some(Value::String(t)) => return Some(t.clone()),
        Some(Value::Array(types)) => {
            let t = types.iter().filter_map(Value::as_str).find(|t| *t != "null").or(types.first().and_then(Value::as_str));
            return t.map(str::to_string);
        }
        _ => {}
    }
    if obj.contains_key("properties") || obj.contains_key("additionalProperties") {
        Some("object".into())
    } else if obj.contains_key("items") || obj.contains_key("prefixItems") {
        Some("array".into())
    } else if obj.contains_key("format") || obj.contains_key("pattern") || obj.contains_key("minLength") {
        Some("string".into())
    } else {
        None
    }
}

pub(crate) fn is_binary(obj: &Map<String, Value>) -> bool {
    let format = obj.get("format").and_then(Value::as_str);
    matches!(format, Some("binary") | Some("base64"))
        || obj.contains_key("contentMediaType")
        || obj.get("contentEncoding").and_then(Value::as_str) == Some("base64")
}

fn string_example(obj: &Map<String, Value>) -> String {
    let s = match obj.get("format").and_then(Value::as_str).unwrap_or("") {
        "date-time" => "2024-01-01T12:00:00Z",
        "date" => "2024-01-01",
        "time" => "12:00:00",
        "duration" => "P1D",
        "email" | "idn-email" => "user@example.com",
        "uuid" => "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "uri" | "url" | "iri" | "uri-reference" => "https://example.com",
        "hostname" | "idn-hostname" => "example.com",
        "ipv4" => "192.168.0.1",
        "ipv6" => "::1",
        "byte" => "U3dhZ2dlciByb2Nrcw==",
        "binary" => "<binary>",
        "password" => "password",
        "int64" | "int32" => "0",
        _ => "string",
    };
    s.to_string()
}

fn number_example(obj: &Map<String, Value>) -> Option<f64> {
    if let Some(min) = obj.get("minimum").and_then(Value::as_f64) {
        let exclusive = obj.get("exclusiveMinimum").and_then(Value::as_bool) == Some(true);
        return Some(if exclusive { min + 1.0 } else { min });
    }
    if let Some(min) = obj.get("exclusiveMinimum").and_then(Value::as_f64) {
        return Some(min + 1.0);
    }
    obj.get("maximum").and_then(Value::as_f64).filter(|m| *m < 1.0)
}
