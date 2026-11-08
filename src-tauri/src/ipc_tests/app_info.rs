//! About HttpDesk and Report an Issue: the app's version, OS and architecture.

use serde_json::json;
use tauri::test::{mock_builder, mock_context, noop_assets};

use super::Harness;

#[test]
fn app_info_is_the_configured_version_with_the_os_and_architecture() {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = "4.5.6".parse().unwrap();
    let h = Harness::with(mock_builder(), context);

    let info = h.ok("app_info", json!({}));

    assert_eq!(info["version"], json!("4.5.6"));
    assert!(!info["os"].as_str().unwrap().is_empty(), "{info}");
    assert!(!info["arch"].as_str().unwrap().is_empty(), "{info}");
}

/// The app with its real capabilities (src-tauri/capabilities) and the opener plugin.
fn with_capabilities() -> Harness {
    Harness::with(mock_builder().plugin(tauri_plugin_opener::init()), tauri::generate_context!(test = true))
}

#[test]
fn the_opener_refuses_urls_outside_the_projects_github_pages() {
    let h = with_capabilities();
    for url in [
        "https://example.com/",
        "http://github.com/jrmitch120/http-desk/releases",
        "https://github.com/someone-else/http-desk/issues/new",
        "https://github.com/jrmitch120/http-desk-lookalike/releases",
        "https://github.com/jrmitch120/http-desk.evil.example/",
        "file:///etc/passwd",
        "mailto:someone@example.com",
    ] {
        let refused = h.call("plugin:opener|open_url", json!({ "url": url })).expect_err(url);
        // The opener's own scope check, not a missing permission.
        assert_eq!(refused, json!(format!("Not allowed to open url {url}")), "{url}");
    }
}
