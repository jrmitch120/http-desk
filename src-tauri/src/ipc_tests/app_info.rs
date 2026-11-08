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

/// One `opener:allow-open-url` scope entry, read as the opener reads it.
#[derive(serde::Deserialize, Debug)]
struct UrlEntry {
    url: String,
    /// The program to open with; an entry without one is for the default browser.
    app: Option<serde_json::Value>,
}

/// Stands in for the opener's `open_url`: the same permission and scope (which
/// Tauri resolves from the real capabilities) and the same glob match, but it
/// opens nothing, so a test can call it with a URL the scope lets through.
#[tauri::command]
fn open_url(
    scope: tauri::ipc::CommandScope<UrlEntry>,
    global: tauri::ipc::GlobalScope<UrlEntry>,
    url: String,
) -> Result<(), String> {
    let matches = |e: &&std::sync::Arc<UrlEntry>| e.app.is_none() && glob::Pattern::new(&e.url).unwrap().matches(&url);
    let denied = scope.denies().iter().chain(global.denies()).any(|e| matches(&e));
    let allowed = scope.allows().iter().chain(global.allows()).any(|e| matches(&e));
    if allowed && !denied {
        Ok(())
    } else {
        Err(format!("Not allowed to open url {url}"))
    }
}

#[test]
fn the_opener_lets_through_the_links_the_app_opens() {
    let opener = tauri::plugin::Builder::<_>::new("opener").invoke_handler(tauri::generate_handler![open_url]).build();
    let h = Harness::with(mock_builder().plugin(opener), tauri::generate_context!(test = true));
    for url in [
        // Help → Documentation, and About's link (src/lib/about.ts).
        "https://github.com/jrmitch120/http-desk#readme",
        // Help → Release Notes.
        "https://github.com/jrmitch120/http-desk/releases",
        // Help → Report an Issue, with the body `reportIssueUrl` builds (src/lib/about.test.ts).
        "https://github.com/jrmitch120/http-desk/issues/new?body=**Version%3A**%20HttpDesk%200.9.8%20(macos%20aarch64)%0A%0A**What%20happened%3F**%0A%0A%0A**What%20did%20you%20expect%3F**%0A%0A%0A**Steps%20to%20reproduce**%0A%0A",
    ] {
        h.call("plugin:opener|open_url", json!({ "url": url }))
            .unwrap_or_else(|e| panic!("{url}: {e}"));
    }
    // The stand-in refuses what the opener refuses.
    let outside = "https://example.com/";
    let refused = h.call("plugin:opener|open_url", json!({ "url": outside })).unwrap_err();
    assert_eq!(refused, json!(format!("Not allowed to open url {outside}")));
}
