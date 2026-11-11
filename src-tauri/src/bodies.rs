//! Response bodies by response id, kept so "save to file" can write the bytes
//! the UI only shows as text, the Hex view can dump them, and the Pretty view
//! and the filter can work on them. A body is kept until the webview releases
//! it (its tab closed or got a newer response) or the page loads again, so an
//! open tab never loses its response; there is no count or byte limit.

use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub(crate) struct KeptBodies {
    entries: HashMap<String, Stored>,
}

/// A body and its response's content type (which says how to decode it as text).
struct Stored {
    bytes: Arc<[u8]>,
    content_type: Option<String>,
}

impl KeptBodies {
    /// Keeps `body` as response `id`'s until it's released.
    pub(crate) fn push(&mut self, id: String, body: Vec<u8>, content_type: Option<String>) {
        self.entries.insert(id, Stored { bytes: body.into(), content_type });
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<[u8]>> {
        self.get_with_type(id).map(|(bytes, _)| bytes)
    }

    /// The body and its response's content type.
    pub(crate) fn get_with_type(&self, id: &str) -> Option<(Arc<[u8]>, Option<String>)> {
        self.entries.get(id).map(|s| (s.bytes.clone(), s.content_type.clone()))
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    /// Drops response `id`'s body (nothing if it isn't kept).
    pub(crate) fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }

    /// Drops every body.
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }
}
