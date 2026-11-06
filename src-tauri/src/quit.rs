//! Quitting with unsaved files. Closing the window already asks (the frontend's
//! close-requested handler); app-level quits must ask the same way.
//!
//! On macOS, ⌘Q (the app menu's Quit item), Dock → Quit and logout all send
//! `-[NSApplication terminate:]`, which tao lets through without any Tauri
//! event, so the app would just exit. `install` gives tao's app delegate an
//! `applicationShouldTerminate:` that turns such a quit into a close request
//! on the main window while files are unsaved.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, Runtime};

use crate::AppState;

/// Handles an app-level quit request. True to quit now; false when the main
/// window was asked to close instead, so the user can save, discard or cancel.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // only macOS quits without closing the window
pub fn on_quit_request<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !app.state::<AppState>().unsaved.load(Ordering::Relaxed) {
        return true;
    }
    let Some(window) = app.get_webview_window("main") else { return true };
    // Dock → Quit works while the window is minimized or behind other apps.
    let _ = window.unminimize();
    let _ = window.set_focus();
    window.close().is_err()
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, ffi, msg_send, sel};
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    // NSApplicationTerminateReply
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        match APP.get() {
            Some(app) if !super::on_quit_request(app) => TERMINATE_CANCEL,
            _ => TERMINATE_NOW,
        }
    }

    /// Adds `applicationShouldTerminate:` to the app delegate. Call on the main
    /// thread once the event loop exists (the `setup` hook).
    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                return;
            }
            let cls = ffi::object_getClass(delegate) as *mut AnyClass;
            let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize);
            // NSUInteger (id self, SEL _cmd, id sender). Fails (and changes
            // nothing) if tao ever implements the method itself.
            let added = ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
            if !added.as_bool() {
                eprintln!("HttpDesk: app delegate already handles applicationShouldTerminate:");
                return;
            }
            // Set the delegate again so AppKit re-reads which methods it implements.
            let _: () = msg_send![ns_app, setDelegate: std::ptr::null_mut::<AnyObject>()];
            let _: () = msg_send![ns_app, setDelegate: delegate];
        }
    }
}
