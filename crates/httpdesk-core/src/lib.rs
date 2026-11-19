//! HttpDesk core: `.http` parsing/serialization, variables, environments,
//! request execution (a send and a Run), the workspace Session, History and OpenAPI generation. No UI or Tauri
//! dependencies.

pub mod body_format;
pub mod cookies;
pub mod env;
pub mod exchange;
pub mod exec;
pub mod history;
pub mod json_filter;
pub mod openapi;
pub mod run;
pub mod script;
pub mod send;
pub mod session;
mod tls_probe;
pub mod vars;
pub mod workspace;

// The text model, parser and serializer live in their own crate (it also builds
// to WASM for the dev mock); they read as part of the core.
use httpdesk_text::query;
pub use httpdesk_text::{model, parser, portability, serializer};

pub use model::*;
pub use parser::{parse, parse_request, parse_with_problems};
pub use serializer::{render_request, request_source, request_text, serialize, try_serialize, InvalidField};
