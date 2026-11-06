import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReleaseVersion } from "./check-release-version.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-release-version.mjs");

/** Runs the CLI in a fresh repo-shaped folder holding `files`. */
function runCli(tag: string, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "httpdesk-release-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return spawnSync(process.execPath, [script, tag], { cwd: root, encoding: "utf8" });
}

function manifests(
  versions: {
    packageJson?: string;
    tauriConf?: string;
    cargoToml?: string;
    lockApp?: string;
    lockCore?: string;
  } = {},
) {
  const v = (x: string | undefined) => x ?? "0.1.3";
  return {
    "package.json": JSON.stringify({ name: "httpdesk", version: v(versions.packageJson) }, null, 2),
    "src-tauri/tauri.conf.json": JSON.stringify(
      { productName: "HttpDesk", version: v(versions.tauriConf) },
      null,
      2,
    ),
    "Cargo.toml": [
      "[workspace]",
      'members = ["crates/httpdesk-core", "src-tauri"]',
      "",
      "[workspace.package]",
      `version = "${v(versions.cargoToml)}"`,
      'edition = "2021"',
      "",
    ].join("\n"),
    "Cargo.lock": [
      "version = 4",
      "",
      "[[package]]",
      'name = "base64"',
      'version = "0.23.1"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "httpdesk"',
      `version = "${v(versions.lockApp)}"`,
      "dependencies = [",
      ' "httpdesk-core",',
      "]",
      "",
      "[[package]]",
      'name = "httpdesk-core"',
      `version = "${v(versions.lockCore)}"`,
      "",
    ].join("\n"),
  };
}

describe("checkReleaseVersion", () => {
  it("accepts a tag that matches every manifest", () => {
    expect(checkReleaseVersion("v0.1.3", manifests())).toEqual([]);
  });

  it("rejects a tag that differs from package.json", () => {
    expect(checkReleaseVersion("v0.1.3", manifests({ packageJson: "0.1.2" }))).toEqual([
      "package.json has version 0.1.2, but the tag is v0.1.3",
    ]);
  });

  it("rejects a tag that differs from tauri.conf.json", () => {
    expect(checkReleaseVersion("v0.1.3", manifests({ tauriConf: "0.1.4" }))).toEqual([
      "src-tauri/tauri.conf.json has version 0.1.4, but the tag is v0.1.3",
    ]);
  });

  it("rejects a tag that differs from the Cargo workspace version", () => {
    expect(checkReleaseVersion("v0.1.3", manifests({ cargoToml: "0.2.0" }))).toEqual([
      "Cargo.toml has version 0.2.0, but the tag is v0.1.3",
    ]);
  });

  it("rejects a Cargo.lock that wasn't refreshed after the bump", () => {
    expect(
      checkReleaseVersion("v0.1.3", manifests({ lockApp: "0.1.2", lockCore: "0.1.2" })),
    ).toEqual([
      "Cargo.lock has version 0.1.2 for httpdesk, but the tag is v0.1.3",
      "Cargo.lock has version 0.1.2 for httpdesk-core, but the tag is v0.1.3",
    ]);
  });

  it("rejects a Cargo.toml whose workspace version can't be found", () => {
    const files = manifests();
    files["Cargo.toml"] = '[workspace]\nmembers = ["src-tauri"]\n';
    expect(checkReleaseVersion("v0.1.3", files)).toEqual([
      "Cargo.toml has no version, but the tag is v0.1.3",
    ]);
  });

  it.each(["main", "0.1.3", "v0.1", ""])("rejects %j, which isn't a release tag", (tag) => {
    expect(checkReleaseVersion(tag, manifests())).toEqual([
      `"${tag}" is not a release tag; expected v<major>.<minor>.<patch>, e.g. v0.1.3`,
    ]);
  });
});

describe("check-release-version CLI", () => {
  it("exits 0 when the tag matches the manifests in the current folder", () => {
    const result = runCli("v0.1.3", manifests());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("exits non-zero and lists every mismatch", () => {
    const result = runCli("v0.1.4", manifests());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package.json has version 0.1.3, but the tag is v0.1.4");
    expect(result.stderr).toContain(
      "Cargo.lock has version 0.1.3 for httpdesk-core, but the tag is v0.1.4",
    );
  });
});
