//! On Windows, the native menu's dropdowns in the Theme setting (ADR-0011).
//!
//! muda draws the menu bar strip itself, from the window theme, but Windows draws
//! the dropdowns (and every other Win32 menu of the process, such as Alt+Space)
//! from the process's preferred app mode. tao only *allows* dark mode, so without
//! this the dropdowns follow the Windows app mode. tao also resets the app mode
//! whenever the window theme is set, so `apply` must run after that, every time.
//! On macOS and Linux `apply` does nothing.

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

/// The menu app mode for a Theme setting: a fixed theme forces it, System (or
/// anything unknown) follows Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_mode(choice: &str) -> AppMode {
    match choice {
        "light" => AppMode::ForceLight,
        "dark" => AppMode::ForceDark,
        _ => AppMode::AllowDark,
    }
}

/// Puts the process's menus in the Theme setting `choice`. Call it after the
/// window theme is set. Does nothing if uxtheme lacks the functions, or off Windows.
#[cfg(windows)]
pub fn apply(choice: &str) {
    if let Some(uxtheme) = uxtheme::get() {
        // SAFETY: both pointers come from uxtheme with these signatures (ordinals
        // 135 and 136 since Windows 10 1903), and take no pointers.
        unsafe {
            (uxtheme.set_preferred_app_mode)(app_mode(choice) as i32);
            (uxtheme.flush_menu_themes)();
        }
    }
}

#[cfg(not(windows))]
pub fn apply(_choice: &str) {}

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
        assert_eq!(app_mode("light"), AppMode::ForceLight);
        assert_eq!(app_mode("dark"), AppMode::ForceDark);
        assert_eq!(app_mode("system"), AppMode::AllowDark);
        assert_eq!(app_mode("sepia"), AppMode::AllowDark);
    }
}
