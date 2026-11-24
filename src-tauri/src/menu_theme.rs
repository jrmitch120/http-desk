//! On Windows, the native menu's dropdowns in the Theme setting (ADR-0011).
//!
//! muda draws the menu bar strip itself, from the window theme, but Windows draws
//! the dropdowns (and every other Win32 menu of the process, such as Alt+Space)
//! from the process's preferred app mode. tao only *allows* dark mode, so without
//! this the dropdowns follow the Windows app mode. tao sets the app mode when its
//! event loop starts, and a later tao could set it with the window theme too, so
//! `apply` runs after the window theme is set, every time: `theme::set_theme` does
//! both. On macOS and Linux `apply` does nothing.

use crate::theme::ThemeSetting;

/// uxtheme's `PreferredAppMode` values this module uses (`Default`, 0, is unused).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
#[repr(i32)]
pub enum AppMode {
    /// Menus follow the Windows app mode (what tao sets).
    AllowDark = 1,
    ForceDark = 2,
    ForceLight = 3,
}

/// The menu app mode for a Theme setting: a fixed theme forces it, System follows
/// Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_mode(setting: ThemeSetting) -> AppMode {
    match setting {
        ThemeSetting::Light => AppMode::ForceLight,
        ThemeSetting::Dark => AppMode::ForceDark,
        ThemeSetting::System => AppMode::AllowDark,
    }
}

/// Whether ordinal 135 is `SetPreferredAppMode` on this Windows build: it is from
/// Windows 10 1903 (build 18362); before that it is `AllowDarkModeForApp(bool)`.
/// tao makes the same check.
#[cfg_attr(not(windows), allow(dead_code))]
fn sets_app_mode(build: u32) -> bool {
    build >= 18362
}

/// Puts the process's menus in the Theme `setting`. Call it after the window theme
/// is set, on the main thread (`theme::set_theme` does both). Does nothing before
/// Windows 10 1903, if uxtheme lacks the functions, or off Windows.
#[cfg(windows)]
pub fn apply(setting: ThemeSetting) {
    if !sets_app_mode(windows_version::OsVersion::current().build) {
        return;
    }
    if let Some(uxtheme) = uxtheme::get() {
        // SAFETY: both pointers come from uxtheme with these signatures (ordinals
        // 135 and 136 since Windows 10 1903, checked above), and take no pointers.
        unsafe {
            (uxtheme.set_preferred_app_mode)(app_mode(setting) as i32);
            (uxtheme.flush_menu_themes)();
        }
    }
}

#[cfg(not(windows))]
pub fn apply(_setting: ThemeSetting) {}

#[cfg(windows)]
mod uxtheme {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

    /// What `GetProcAddress` returns, and the two functions' real types.
    type Farproc = unsafe extern "system" fn() -> isize;
    type SetPreferredAppMode = unsafe extern "system" fn(i32) -> i32;
    type FlushMenuThemes = unsafe extern "system" fn();

    pub struct Uxtheme {
        pub set_preferred_app_mode: SetPreferredAppMode,
        pub flush_menu_themes: FlushMenuThemes,
    }

    /// uxtheme's unnamed exports, looked up once; `None` if either is missing.
    pub fn get() -> Option<&'static Uxtheme> {
        static UXTHEME: OnceLock<Option<Uxtheme>> = OnceLock::new();
        UXTHEME.get_or_init(load).as_ref()
    }

    fn load() -> Option<Uxtheme> {
        let name: Vec<u16> = "uxtheme.dll".encode_utf16().chain([0]).collect();
        // SAFETY: `name` is NUL-terminated; an ordinal is passed as the name
        // pointer's low word (MAKEINTRESOURCEA). The module is never freed, so
        // the pointers stay valid, and the transmutes give them their real types.
        unsafe {
            let module = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
            if module.is_null() {
                return None;
            }
            let set = GetProcAddress(module, 135 as _)?;
            let flush = GetProcAddress(module, 136 as _)?;
            Some(Uxtheme {
                set_preferred_app_mode: std::mem::transmute::<Farproc, SetPreferredAppMode>(set),
                flush_menu_themes: std::mem::transmute::<Farproc, FlushMenuThemes>(flush),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_theme_forces_the_menu_mode_and_system_follows_windows() {
        assert_eq!(app_mode(ThemeSetting::Light), AppMode::ForceLight);
        assert_eq!(app_mode(ThemeSetting::Dark), AppMode::ForceDark);
        assert_eq!(app_mode(ThemeSetting::System), AppMode::AllowDark);
    }

    #[test]
    fn the_app_mode_is_only_set_from_windows_10_1903() {
        // Before build 18362, ordinal 135 is AllowDarkModeForApp(bool).
        assert!(!sets_app_mode(17763));
        assert!(sets_app_mode(18362));
        assert!(sets_app_mode(26100));
    }
}
