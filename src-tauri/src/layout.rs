//! Each workspace's Layout (GLOSSARY): how the user left it, saved by the
//! frontend once changes settle and loaded when the workspace opens. One small
//! JSON document per workspace in `<config>/layouts/`, named after a hash of
//! the workspace's canonical path; never inside the workspace (spec #40,
//! "What's on disk": nothing is written inside the workspace).
//!
//! The shell doesn't read the Layout: the frontend owns its shape and checks it
//! when it loads one. A missing or damaged file loads as no Layout.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::{err, paths, CmdResult};

#[derive(Serialize, Deserialize)]
struct Stored {
    /// The workspace it belongs to, so a file name collision can't load another's Layout.
    root: PathBuf,
    layout: Value,
}

#[tauri::command]
pub async fn load_layout<R: tauri::Runtime>(app: AppHandle<R>, root: PathBuf) -> CmdResult<Option<Value>> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical(&root);
        let path = layout_path(&app, &root)?;
        let stored: Stored = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        (stored.root == root).then_some(stored.layout)
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn save_layout<R: tauri::Runtime>(app: AppHandle<R>, root: PathBuf, layout: Value) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical(&root);
        let Some(path) = layout_path(&app, &root) else { return Ok(()) };
        let text = serde_json::to_string(&Stored { root, layout }).map_err(err)?;
        httpdesk_core::workspace::write_atomic(&path, text.as_bytes())
            .map_err(|e| format!("Could not save the layout to {}: {e}", path.display()))
    })
    .await
    .map_err(err)?
}

/// The workspace's canonical path; as given if it can't be resolved (a folder
/// deleted while open still saves under the path it was opened by).
fn canonical(root: &Path) -> PathBuf {
    paths::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

fn layout_path<R: tauri::Runtime>(app: &AppHandle<R>, root: &Path) -> Option<PathBuf> {
    let name = format!("{:016x}.json", fnv1a(root.to_string_lossy().as_bytes()));
    Some(crate::config_dir(app)?.join("layouts").join(name))
}

/// FNV-1a, 64-bit: stable across Rust versions, unlike `DefaultHasher`, so the
/// same workspace always finds the same file.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}
