import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Returns the problems that stop `tag` from being released; empty when it may be.
 * @param {string} tag
 * @param {Record<string, string>} files manifest contents keyed by repo-relative path
 * @returns {string[]}
 */
export function checkReleaseVersion(tag, files) {
  const tagMatch = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/.exec(tag);
  if (!tagMatch) {
    return [`"${tag}" is not a release tag; expected v<major>.<minor>.<patch>, e.g. v0.1.3`];
  }
  const version = tagMatch[1];
  const problems = [];
  const found = [
    ["package.json", JSON.parse(files["package.json"]).version],
    ["src-tauri/tauri.conf.json", JSON.parse(files["src-tauri/tauri.conf.json"]).version],
    ["Cargo.toml", tomlTables(files["Cargo.toml"]).find((t) => t.header === "[workspace.package]")?.version],
  ];
  // Workspace crates are the lockfile packages that don't come from a registry or git.
  for (const pkg of tomlTables(files["Cargo.lock"])) {
    if (pkg.header === "[[package]]" && pkg.source === undefined) {
      found.push(["Cargo.lock", pkg.version, pkg.name]);
    }
  }
  for (const [file, v, crate] of found) {
    if (v === version) continue;
    const what = (v === undefined ? "no version" : `version ${v}`) + (crate ? ` for ${crate}` : "");
    problems.push(`${file} has ${what}, but the tag is ${tag}`);
  }
  return problems;
}

/**
 * Splits TOML into its tables, keeping each table's header and simple string keys.
 * Enough for Cargo manifests and lockfiles; not a general TOML parser.
 * @param {string} text
 * @returns {Array<{ header: string } & Record<string, string>>}
 */
function tomlTables(text) {
  const tables = [{ header: "" }];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      tables.push({ header: trimmed });
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(trimmed);
    if (m) tables[tables.length - 1][m[1]] = m[2];
  }
  return tables;
}

// CLI: `node scripts/check-release-version.mjs <tag>`, run from the repo root.
// Exits 1 and prints every mismatch when the tag can't be released.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv[2] ?? "";
  const files = Object.fromEntries(
    ["package.json", "src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"].map((path) => [
      path,
      readFileSync(path, "utf8"),
    ]),
  );
  const problems = checkReleaseVersion(tag, files);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      "Release tags are v<version>, where package.json, src-tauri/tauri.conf.json, " +
        "Cargo.toml and Cargo.lock all hold <version>.",
    );
    process.exit(1);
  }
  console.log(`${tag} matches package.json, tauri.conf.json, Cargo.toml and Cargo.lock`);
}
