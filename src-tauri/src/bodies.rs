//! Response bodies by response id. The send reply carries no body (ADR 0006),
//! so this is where the viewer fetches it from (Raw, Pretty, Preview, Hex),
//! and where Copy, Save and the filter work on it. A body is kept until the
//! webview releases it (its tab closed or got a newer response) or the page
//! loads again, so an open tab never loses its response; there is no count or
//! byte limit.

use std::collections::HashMap;
use std::sync::Arc;

use httpdesk_core::body_format::ResponseKind;
use httpdesk_core::exec;

#[derive(Default)]
pub(crate) struct KeptBodies {
    entries: HashMap<String, KeptBody>,
}

/// A kept body, with its response's content type (which says how to decode it
/// as text) and body kind (which says whether it is text at all).
#[derive(Clone)]
pub(crate) struct KeptBody {
    pub bytes: Arc<[u8]>,
    pub content_type: Option<String>,
    pub kind: ResponseKind,
}

impl KeptBody {
    /// The body as the text the viewer shows (see `exec::body_text`), or
    /// `None` when its kind is binary.
    pub(crate) fn text(&self) -> Option<String> {
        exec::body_text(&self.bytes, self.content_type.as_deref(), self.kind)
    }
}

impl KeptBodies {
    /// Keeps `body` as response `id`'s until it's released.
    pub(crate) fn push(&mut self, id: String, body: Vec<u8>, content_type: Option<String>, kind: ResponseKind) {
        self.entries.insert(id, KeptBody { bytes: body.into(), content_type, kind });
    }

    /// The body's bytes.
    pub(crate) fn get(&self, id: &str) -> Option<Arc<[u8]>> {
        self.entries.get(id).map(|s| s.bytes.clone())
    }

    /// The body with its content type and kind.
    pub(crate) fn get_kept(&self, id: &str) -> Option<KeptBody> {
        self.entries.get(id).cloned()
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
