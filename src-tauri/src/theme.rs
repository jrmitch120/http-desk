//! The main window, created with the saved theme and zoom already applied so the
//! first frame is in the right colours (the page CSS defaults to dark) and at the
//! right size, never at 100% first.

use tauri::window::Color;
use tauri::{Manager, Theme};

/// Creates the app's only window, "main" from tauri.conf.json (which has
/// `"create": false`), in the saved `theme` and `zoom` settings; runs at setup once
/// settings are loaded (most IPC tests make their own window). The page's
/// `applyTheme()` (through `set_window_theme`) and `applyZoom()` take over once
/// settings arrive over IPC, setting the same theme and zoom again.
///
/// The window is created hidden and shown once its saved size and place are
/// restored (window_state.rs), so it never appears at the default size first.
pub fn create_main_window<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let state = app.state::<crate::AppState>();
    let (choice, zoom) = {
        let settings = state.settings.lock().unwrap();
        (settings.theme.clone(), settings.zoom)
    };
    let config = app.config().app.windows.iter().find(|w| w.label == "main").ok_or(tauri::Error::WindowNotFound)?;
    let setting = ThemeSetting::parse(&choice);
    let fixed = setting.window_theme();
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)?
        .theme(fixed)
        .visible(false)
        // Main frame only (Windows also runs it in subframes, so the script checks):
        // response previews are iframes with their own styles.
        .initialization_script(page_script(&choice));
    if let Some(theme) = fixed {
        builder = builder.background_color(background(theme));
    }
    let window = builder.build()?;
    // The builder set the window theme for the first frame; setting it again changes
    // nothing, but puts the Windows menus in it too, before any menu opens.
    set_theme(&window, setting)?;
    // The webview keeps its zoom across page loads, and the window is still hidden.
    window.set_zoom(zoom)?;
    if fixed.is_none() {
        // System: the window now knows the OS appearance. Still before the first
        // frame, which the event loop draws after setup.
        window.set_background_color(Some(background(window.theme().unwrap_or(Theme::Dark))))?;
    }
    crate::window_state::show_restored(&window)
}

/// Sets the native window theme for the Theme setting `theme` (light, dark or
/// system): a fixed theme pins it, System (or anything unknown) lets it follow the
/// OS. The page's `applyTheme()` calls this only when the Theme setting changes.
///
/// A sync command, so Tauri runs it on the main thread, where `set_theme`'s two
/// steps take effect in order (menu_theme.rs).
#[tauri::command]
pub fn set_window_theme<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    #[cfg_attr(not(test), allow(unused_variables))] state: tauri::State<'_, crate::AppState>,
    theme: String,
) -> Result<(), String> {
    let setting = ThemeSetting::parse(&theme);
    set_theme(&window, setting).map_err(|e| e.to_string())?;
    #[cfg(test)]
    state.window_themes.lock().unwrap().push(setting.window_theme());
    Ok(())
}

/// Sets the window theme for `setting`, then puts the Windows menus in it: the menu
/// mode has to be applied after the window theme (ADR-0011), so all code that sets
/// the window theme goes through here. Call it on the main thread, where the window
/// theme is set before this returns.
fn set_theme<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, setting: ThemeSetting) -> tauri::Result<()> {
    window.set_theme(setting.window_theme())?;
    crate::menu_theme::apply(setting);
    Ok(())
}

/// The Theme setting. The settings file holds it as a string, which a hand edit
/// can make anything; anything but light or dark means System.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeSetting {
    Light,
    Dark,
    System,
}

impl ThemeSetting {
    pub fn parse(setting: &str) -> Self {
        match setting {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }

    /// The native window theme: a fixed theme pins it, System follows the OS (`None`).
    fn window_theme(self) -> Option<Theme> {
        match self {
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
            Self::System => None,
        }
    }
}

/// `--bg` in src/app.css for each theme (checked by a test).
fn background(theme: Theme) -> Color {
    match theme {
        Theme::Light => Color(0xf3, 0xf4, 0xf6, 0xff),
        _ => Color(0x1c, 0x1d, 0x20, 0xff),
    }
}

/// A script that sets `data-theme` on `<html>` before the page first paints
/// (theme-boot.js, which the browser tests also run).
fn page_script(choice: &str) -> String {
    include_str!("theme-boot.js").replace("__THEME__", &serde_json::to_string(choice).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_theme_pins_the_window_and_system_follows_the_os() {
        assert_eq!(ThemeSetting::parse("light").window_theme(), Some(Theme::Light));
        assert_eq!(ThemeSetting::parse("dark").window_theme(), Some(Theme::Dark));
        assert_eq!(ThemeSetting::parse("system").window_theme(), None);
    }

    #[test]
    fn an_unknown_theme_setting_means_system() {
        assert_eq!(ThemeSetting::parse("sepia"), ThemeSetting::System);
        assert_eq!(ThemeSetting::parse(""), ThemeSetting::System);
    }

    // What the script does is checked in the browser (e2e/startup-theme.spec.ts).
    #[test]
    fn the_page_script_is_given_the_theme_setting() {
        assert!(page_script("light").trim_end().ends_with(r#"})("light");"#));
        assert!(page_script("system").trim_end().ends_with(r#"})("system");"#));
        assert!(!page_script("dark").contains("__THEME__"));
    }

    #[test]
    fn the_page_script_quotes_the_setting_safely() {
        // A hand-edited settings file can hold anything; it must stay one JS string.
        assert!(page_script(r#"x");alert(1);("#).trim_end().ends_with(r#"})("x\");alert(1);(");"#));
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
