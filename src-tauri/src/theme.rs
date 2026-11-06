//! The main window, created with the saved theme already applied so the first
//! frame is in the right colours (the page CSS defaults to dark).

use tauri::window::Color;
use tauri::Theme;

/// Creates the "main" window from tauri.conf.json (which has `"create": false`)
/// in the theme `choice` (the `theme` setting). The page's `applyTheme()` takes
/// over once settings arrive over IPC, setting the same theme again.
pub fn create_main_window<R: tauri::Runtime, M: tauri::Manager<R>>(app: &M, choice: &str) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").ok_or(tauri::Error::WindowNotFound)?;
    let fixed = window_theme(choice);
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)?
        .theme(fixed)
        // Main frame only: response previews are iframes with their own styles.
        .initialization_script(page_script(choice));
    if let Some(theme) = fixed {
        builder = builder.background_color(background(theme));
    }
    let window = builder.build()?;
    if fixed.is_none() {
        // System: the window now knows the OS appearance. Still before the first
        // frame, which the event loop draws after setup.
        window.set_background_color(Some(background(window.theme().unwrap_or(Theme::Dark))))?;
    }
    Ok(())
}

/// `--bg` in src/app.css for each theme (checked by a test).
fn background(theme: Theme) -> Color {
    match theme {
        Theme::Light => Color(0xf3, 0xf4, 0xf6, 0xff),
        _ => Color(0x1c, 0x1d, 0x20, 0xff),
    }
}

/// The native window theme for a theme setting: a fixed theme pins it, System
/// (or anything unknown) follows the OS.
fn window_theme(choice: &str) -> Option<Theme> {
    match choice {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// A script that sets `data-theme` on `<html>` before the page first paints,
/// resolving System the way `effectiveTheme` in src/lib/store.svelte.ts does.
fn page_script(choice: &str) -> String {
    let theme = match choice {
        "light" | "dark" => format!("\"{choice}\""),
        _ => r#"matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light""#.into(),
    };
    format!("document.documentElement.dataset.theme = {theme};")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_theme_pins_the_window_and_system_follows_the_os() {
        assert_eq!(window_theme("light"), Some(Theme::Light));
        assert_eq!(window_theme("dark"), Some(Theme::Dark));
        assert_eq!(window_theme("system"), None);
        assert_eq!(window_theme("sepia"), None);
    }

    #[test]
    fn the_page_script_sets_a_fixed_theme_as_is() {
        assert_eq!(page_script("light"), r#"document.documentElement.dataset.theme = "light";"#);
        assert_eq!(page_script("dark"), r#"document.documentElement.dataset.theme = "dark";"#);
    }

    #[test]
    fn the_page_script_resolves_system_like_the_store_does() {
        // store.svelte.ts: dark unless the OS appearance says otherwise.
        let expected = r#"document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";"#;
        assert_eq!(page_script("system"), expected);
        assert_eq!(page_script("sepia"), expected);
    }

    #[test]
    fn the_window_background_is_the_themes_page_background() {
        assert_eq!(background(Theme::Dark), Color(0x1c, 0x1d, 0x20, 0xff));
        assert_eq!(background(Theme::Light), Color(0xf3, 0xf4, 0xf6, 0xff));
    }

    /// `--bg` in the first rule of src/app.css whose selector is `selector`, as a colour.
    fn css_bg(css: &str, selector: &str) -> Color {
        let start = css.find(&format!("{selector} {{")).unwrap_or_else(|| panic!("no `{selector}` rule in app.css"));
        let rule = &css[start..start + css[start..].find('}').unwrap()];
        let hex = rule.split("--bg:").nth(1).expect("rule sets --bg").trim_start();
        let hex = hex.strip_prefix('#').expect("--bg is a #rrggbb colour");
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
        Color(byte(0), byte(2), byte(4), 0xff)
    }

    #[test]
    fn the_window_backgrounds_match_the_page_css() {
        let css = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/app.css")).unwrap();
        assert_eq!(background(Theme::Dark), css_bg(&css, ":root"), "dark --bg in src/app.css");
        assert_eq!(background(Theme::Light), css_bg(&css, r#":root[data-theme="light"]"#), "light --bg in src/app.css");
    }
}
