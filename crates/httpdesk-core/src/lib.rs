//! HttpDesk core: `.http` parsing/serialization, variables, environments,
//! request execution and OpenAPI generation. No UI or Tauri dependencies.

pub mod body_format;
pub mod env;
pub mod exec;
pub mod model;
pub mod openapi;
pub mod parser;
mod query;
pub mod serializer;
pub mod vars;
pub mod workspace;

pub use model::*;
pub use parser::parse;
pub use serializer::{render_request, serialize, try_serialize, InvalidField};
