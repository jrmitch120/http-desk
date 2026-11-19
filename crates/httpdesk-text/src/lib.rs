//! The `.http` text model, parser and serializer, with nothing else: no network,
//! script, storage or async dependencies, so it also builds to WASM for the dev
//! mock (`crates/httpdesk-text-wasm`). `httpdesk-core` re-exports it.

pub mod model;
pub mod parser;
pub mod portability;
pub mod query;
pub mod serializer;
pub mod vars;

pub use model::*;
pub use parser::{parse, parse_request, parse_with_problems};
pub use serializer::{render_request, request_source, request_text, serialize, try_serialize, InvalidField};
