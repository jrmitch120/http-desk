//! The Hex view of a binary response: offset, 16 bytes in hex, then the
//! printable ASCII, for the first 64 KB of the stored body.

use httpdesk_core::body_format::{hexdump, HEX_PREVIEW_BYTES};

#[test]
fn each_line_shows_the_offset_sixteen_hex_bytes_and_printable_ascii() {
    let dump = hexdump(b"Hello, world!\n\x00\xffAB");
    let lines: Vec<&str> = dump.lines().collect();
    assert_eq!(
        lines,
        [
            "00000000  48 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21 0a 00 ff  Hello, world!...",
            &format!("00000010  41 42{}AB", " ".repeat(44)),
        ]
    );
}

#[test]
fn only_the_first_64_kb_are_shown_with_a_note_when_there_is_more() {
    assert_eq!(HEX_PREVIEW_BYTES, 64 * 1024);
    let exact = hexdump(&vec![0x7f; HEX_PREVIEW_BYTES]);
    assert_eq!(exact.lines().count(), 4096);
    assert!(!exact.contains("truncated"));
    assert!(exact.ends_with("0000fff0  7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f 7f  ................"));

    let more = hexdump(&vec![b'a'; HEX_PREVIEW_BYTES + 1]);
    let lines: Vec<&str> = more.lines().collect();
    assert_eq!(lines.len(), 4097);
    assert_eq!(lines[4095], "0000fff0  61 61 61 61 61 61 61 61 61 61 61 61 61 61 61 61  aaaaaaaaaaaaaaaa");
    assert_eq!(lines[4096], "… (truncated preview)");
}

#[test]
fn an_empty_body_dumps_to_nothing() {
    assert_eq!(hexdump(b""), "");
}
