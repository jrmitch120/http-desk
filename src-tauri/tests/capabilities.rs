//! What the webview may do through plugins (capabilities/default.json). Script
//! files are opened by the shell's `open_script_file`, which confines them to the
//! workspace first (#142), so the webview gets no permission to open paths itself.

fn permissions() -> Vec<String> {
    let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    caps["permissions"]
        .as_array()
        .expect("a permissions list")
        .iter()
        .map(|p| p.as_str().or_else(|| p["identifier"].as_str()).expect("a permission identifier").to_string())
        .collect()
}

#[test]
fn the_webview_cant_open_paths() {
    let opener: Vec<_> = permissions().into_iter().filter(|p| p.starts_with("opener:")).collect();
    assert!(!opener.iter().any(|p| p == "opener:allow-open-path" || p == "opener:default"), "{opener:?}");
}
