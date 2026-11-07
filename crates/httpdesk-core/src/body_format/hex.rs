//! The Hex view of a binary body.

use std::fmt::Write;

/// How much of a body the Hex view shows. A dump is about 4.3 characters per
/// byte, so this keeps it to a few hundred KB of text; Save writes the rest.
pub const HEX_PREVIEW_BYTES: usize = 64 * 1024;

/// A classic hex dump of the first [`HEX_PREVIEW_BYTES`] of `bytes`: per line
/// the offset, 16 bytes in hex and their printable ASCII (`.` otherwise), then
/// "… (truncated preview)" if there was more.
pub fn hexdump(bytes: &[u8]) -> String {
    let shown = &bytes[..bytes.len().min(HEX_PREVIEW_BYTES)];
    let mut out = String::with_capacity(shown.len() / 16 * 78 + 32);
    for (n, chunk) in shown.chunks(16).enumerate() {
        if n > 0 {
            out.push('\n');
        }
        let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
        let ascii: String = chunk.iter().map(|&b| if (32..127).contains(&b) { b as char } else { '.' }).collect();
        let _ = write!(out, "{:08x}  {:<47}  {ascii}", n * 16, hex.join(" "));
    }
    if bytes.len() > shown.len() {
        out.push_str("\n… (truncated preview)");
    }
    out
}
