//! Quitting with unsaved files. Closing the window already asks (the frontend's
//! close-requested handler); app-level quits must ask the same way.
//!
//! On macOS, ⌘Q (the app menu's Quit item), Dock → Quit and logout all send
//! `-[NSApplication terminate:]`, which tao lets through without any Tauri
//! event, so the app would just exit. `install` gives tao's app delegate an
//! `applicationShouldTerminate:` that turns such a quit into a close request
//! on the main window. The frontend then asks about unsaved files, or lets
//! the window close at once when there are none, which quits the app.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, Runtime};

use crate::AppState;

/// Who asked the app to quit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum QuitReason {
    /// ⌘Q, the app menu or Dock → Quit.
    User,
    /// The system: logout, restart or shutdown.
    Logout,
}

/// Handles an app-level quit request. True to quit now; false when the main
/// window was asked to close instead, so the user can save, discard or cancel.
///
/// A quit by the user always goes through the window, because only the
/// frontend knows for sure whether edits are unsaved: the `unsaved` flag it
/// reports can be late (⌘Q right after typing) or lost. Cancelling a logout
/// aborts it, though, so a logout trusts the flag and goes ahead when nothing
/// was reported unsaved.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // only macOS quits without closing the window
pub fn on_quit_request<R: Runtime>(app: &AppHandle<R>, reason: QuitReason) -> bool {
    if reason == QuitReason::Logout && !app.state::<AppState>().unsaved.load(Ordering::Relaxed) {
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

    use super::QuitReason;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    // NSApplicationTerminateReply
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    /// `keyAEQuitReason` ('why?'): set on the quit Apple event the system sends
    /// for logout, restart and shutdown; absent for ⌘Q and Dock → Quit.
    const KEY_AE_QUIT_REASON: u32 = u32::from_be_bytes(*b"why?");

    extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        match APP.get() {
            Some(app) if !super::on_quit_request(app, quit_reason()) => TERMINATE_CANCEL,
            _ => TERMINATE_NOW,
        }
    }

    /// Reads the quit reason from the Apple event being handled, if any.
    fn quit_reason() -> QuitReason {
        // SAFETY: called on the main thread from the app delegate. Each message
        // is a documented Foundation method with the argument and return types
        // given here (AEKeyword and OSType are both UInt32), and every object
        // returned is checked for nil before it is messaged.
        let reason: u32 = unsafe {
            let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return QuitReason::User;
            }
            let why: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: KEY_AE_QUIT_REASON];
            if why.is_null() {
                return QuitReason::User;
            }
            msg_send![why, enumCodeValue]
        };
        if reason == 0 {
            QuitReason::User
        } else {
            QuitReason::Logout
        }
    }

    /// Adds `applicationShouldTerminate:` to the app delegate. Call on the main
    /// thread once the event loop exists (the `setup` hook).
    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: runs once, on the main thread (RunEvent::Ready), after tao has
        // set its delegate. `sharedApplication` and `delegate` are documented
        // NSApplication methods returning an object pointer; the delegate is
        // checked for nil before use. `should_terminate` has exactly the C ABI of
        // `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
        // (self, _cmd, id) -> NSUInteger, matching the "Q@:@" type encoding, so
        // transmuting it to the untyped `Imp` is sound. `class_addMethod` only
        // adds the method if the class doesn't already define it. Resetting the
        // delegate to nil and back passes valid pointers to `setDelegate:`.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                return;
            }
            let cls = ffi::object_getClass(delegate) as *mut AnyClass;
            let imp: Imp =
                std::mem::transmute(should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize);
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
