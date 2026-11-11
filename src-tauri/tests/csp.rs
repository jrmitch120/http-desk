//! The webview's content security policy (tauri.conf.json). Response previews
//! load the body's bytes from `blob:` URLs the page makes (#112), so `blob:` is
//! allowed for frames, images, media and PDF objects, and for nothing else; no
//! `data:` URL is allowed anywhere.

use std::collections::HashMap;

/// The policy's directives, each with its sources.
fn csp() -> HashMap<String, Vec<String>> {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let policy = conf["app"]["security"]["csp"].as_str().expect("a CSP string");
    policy
        .split(';')
        .filter_map(|d| {
            let mut words = d.split_whitespace();
            let name = words.next()?.to_string();
            Some((name, words.map(String::from).collect()))
        })
        .collect()
}

#[test]
fn previews_may_load_blob_urls() {
    let csp = csp();
    for directive in ["frame-src", "img-src", "media-src", "object-src"] {
        assert!(csp[directive].contains(&"blob:".to_string()), "{directive} allows blob:");
    }
}

#[test]
fn nothing_else_allows_blob_urls() {
    let mut with_blob: Vec<_> =
        csp().into_iter().filter(|(_, sources)| sources.iter().any(|s| s == "blob:")).map(|(d, _)| d).collect();
    with_blob.sort();
    assert_eq!(with_blob, ["frame-src", "img-src", "media-src", "object-src"]);
}

#[test]
fn no_data_urls() {
    for (directive, sources) in csp() {
        assert!(!sources.iter().any(|s| s == "data:"), "{directive} allows data:");
    }
}
