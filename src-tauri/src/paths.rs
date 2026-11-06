//! Paths in the form users know. On Windows, std's `canonicalize` returns
//! verbatim paths (`\\?\C:\…`), which look odd in the UI and recents and
//! never compare equal to the `C:\…` paths a folder dialog returns.

use std::io;
use std::path::{Path, PathBuf};

/// Like [`std::fs::canonicalize`], but returns `C:\…` instead of the verbatim
/// form on Windows whenever that is lossless. Network shares, reserved device
/// names and over-long paths keep the verbatim form.
pub(crate) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Drops a verbatim prefix from an already-canonical path when that is
/// lossless (recents saved by older versions); a no-op off Windows.
pub(crate) fn simplified(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_dot_dot_and_symlinked_folders() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("a")).unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(canonicalize(&dir.path().join("a/..")).unwrap(), simplified(&real));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_have_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let p = canonicalize(dir.path()).unwrap();
        let s = p.to_string_lossy();
        assert!(!s.starts_with(r"\\?\"), "{s}");
        assert!(s.as_bytes()[1] == b':', "drive path expected: {s}");
    }

    #[cfg(windows)]
    #[test]
    fn simplifies_verbatim_drive_paths_only() {
        assert_eq!(simplified(Path::new(r"\\?\C:\Users\me\api")), Path::new(r"C:\Users\me\api"));
        // Network shares and reserved device names stay verbatim (dunce only strips when lossless).
        assert_eq!(simplified(Path::new(r"\\?\UNC\server\share\api")), Path::new(r"\\?\UNC\server\share\api"));
        assert_eq!(simplified(Path::new(r"\\?\C:\work\CON")), Path::new(r"\\?\C:\work\CON"));
    }

    #[cfg(not(windows))]
    #[test]
    fn simplified_is_a_no_op_off_windows() {
        assert_eq!(simplified(Path::new(r"\\?\C:\x")), Path::new(r"\\?\C:\x"));
    }
}
