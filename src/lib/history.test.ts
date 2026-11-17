// History's page-side constants agree with the shell's (#155).
import { describe, expect, it } from "vitest";
import shell from "../../src-tauri/src/lib.rs?raw";
import core from "../../crates/httpdesk-core/src/history.rs?raw";
import { HISTORY_BODY_CAP, HISTORY_RETENTION } from "./history.svelte";

describe("History's retention defaults", () => {
  it("are 50 entries per request, 30 days and 200 MB", () => {
    expect(HISTORY_RETENTION).toEqual({ maxPerRequest: 50, maxAgeDays: 30, maxSizeMb: 200 });
  });

  it("match the Rust shell's", () => {
    const rust = (name: string) => {
      const m = shell.match(new RegExp(`const ${name}: u32 = (\\d+);`));
      if (!m) throw new Error(`src-tauri/src/lib.rs no longer defines ${name}; update this test`);
      return Number(m[1]);
    };
    expect({ maxPerRequest: rust("MAX_PER_REQUEST"), maxAgeDays: rust("MAX_AGE_DAYS"), maxSizeMb: rust("MAX_SIZE_MB") }).toEqual(HISTORY_RETENTION);
  });
});

describe("History's body cap", () => {
  it("is 10 MB, as the core keeps bodies", () => {
    expect(HISTORY_BODY_CAP).toBe(10 * 1024 * 1024);
    expect(core).toContain("pub const BODY_CAP: usize = 10 * 1024 * 1024;");
  });
});
