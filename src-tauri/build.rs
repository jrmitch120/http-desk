fn main() {
    let mut attributes = tauri_build::Attributes::new();

    // On Windows, tauri-build embeds the app manifest (Common Controls v6) into
    // the app binary only, so `cargo test` binaries that link Tauri fail to start
    // with STATUS_ENTRYPOINT_NOT_FOUND. Embed the same manifest via linker args
    // instead, which apply to every target, tests included.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
