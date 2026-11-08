// About HttpDesk's version line and the Report an Issue link.
import { describe, expect, it } from "vitest";
import { reportIssueUrl, versionLine } from "./about";

const info = { version: "0.9.8", os: "macos", arch: "aarch64" };

describe("versionLine", () => {
  it("names the app, its version, OS and architecture", () => {
    expect(versionLine(info)).toBe("HttpDesk 0.9.8 (macos aarch64)");
    expect(versionLine({ version: "1.0.0-beta.2", os: "windows", arch: "x86_64" })).toBe("HttpDesk 1.0.0-beta.2 (windows x86_64)");
  });
});

describe("reportIssueUrl", () => {
  // The Rust test that this URL gets through the opener's scope uses the same
  // one (src-tauri/src/ipc_tests/app_info.rs).
  const URL_FOR_INFO =
    "https://github.com/jrmitch120/http-desk/issues/new?body=**Version%3A**%20HttpDesk%200.9.8%20(macos%20aarch64)%0A%0A**What%20happened%3F**%0A%0A%0A**What%20did%20you%20expect%3F**%0A%0A%0A**Steps%20to%20reproduce**%0A%0A";

  it("opens a new issue on the project with the version, OS and architecture filled in", () => {
    expect(reportIssueUrl(info)).toBe(URL_FOR_INFO);
  });

  it("encodes the body so it survives as one query parameter", () => {
    const url = new URL(reportIssueUrl({ version: "1.0.0+build&x=1", os: "linux", arch: "x86_64" }));
    expect([...url.searchParams.keys()]).toEqual(["body"]);
    expect(url.searchParams.get("body")).toMatch(/^\*\*Version:\*\* HttpDesk 1\.0\.0\+build&x=1 \(linux x86_64\)\n\n\*\*What happened\?\*\*/);
  });
});
