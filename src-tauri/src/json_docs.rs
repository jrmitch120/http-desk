//! Parsed JSON response bodies by response id, so the filter bar can run a
//! query on every keystroke without re-parsing a large body each time.
//! Parsed values are several times the size of the text, so only a few are kept.

use std::collections::VecDeque;
use std::sync::Arc;

use httpdesk_core::json_filter::JsonDocument;

/// A parse outcome; a body that isn't JSON is remembered as its error message.
pub(crate) type Parsed = Result<Arc<JsonDocument>, String>;

pub(crate) struct JsonDocs {
    max_count: usize,
    entries: VecDeque<(String, Parsed)>,
}

impl Default for JsonDocs {
    fn default() -> Self {
        JsonDocs::new(3)
    }
}

impl JsonDocs {
    pub(crate) fn new(max_count: usize) -> Self {
        JsonDocs { max_count, entries: VecDeque::new() }
    }

    pub(crate) fn get(&self, id: &str) -> Option<Parsed> {
        self.entries.iter().find(|(i, _)| i == id).map(|(_, p)| p.clone())
    }

    /// Keeps `parsed` as the newest entry, dropping the oldest past the cap.
    pub(crate) fn insert(&mut self, id: String, parsed: Parsed) {
        self.entries.retain(|(i, _)| *i != id);
        self.entries.push_back((id, parsed));
        while self.entries.len() > self.max_count {
            self.entries.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JsonDocs;
    use httpdesk_core::json_filter::JsonDocument;
    use std::sync::Arc;

    fn doc(text: &str) -> super::Parsed {
        Ok(Arc::new(JsonDocument::parse(text).unwrap()))
    }

    #[test]
    fn keeps_the_newest_documents_up_to_the_cap() {
        let mut docs = JsonDocs::new(2);
        docs.insert("a".into(), doc("1"));
        docs.insert("b".into(), doc("2"));
        docs.insert("c".into(), Err("not JSON".into()));
        assert!(docs.get("a").is_none());
        assert_eq!(docs.get("b").unwrap().unwrap().filter("$").unwrap().text, "[\n  2\n]");
        assert_eq!(docs.get("c").unwrap().unwrap_err(), "not JSON");
    }
}
