// History's page-side rules agree with the shell's: its constants (#155), and which
// entries are of one request (#158).
import { describe, expect, it } from "vitest";
import shell from "../../src-tauri/src/lib.rs?raw";
import core from "../../crates/httpdesk-core/src/history.rs?raw";
import { compareTarget, HISTORY_BODY_CAP, HISTORY_RETENTION, historyLink, historyLinkKey } from "./history.svelte";
import { newRequest } from "./http";
import type { HistorySummary } from "./types";

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

describe("Compare's next newer entry of the same request, in a list that mixes requests", () => {
  /** An entry sent from `file`'s request written as `GET url` (`# @name` `name`), to `sent`. */
  const entry = (id: number, url: string, sent: string, name: string | null = null, file = "api/pets.http"): HistorySummary =>
    ({ id, time: `2026-11-16T10:00:0${id}Z`, link: { file, name, method: "GET", url }, method: "GET", url: sent }) as HistorySummary;

  it("is an unnamed request's entry sent under another environment: its URL as written links them", () => {
    const entries = [entry(3, "{{host}}/x", "https://staging.test/x"), entry(2, "{{host}}/y", "https://prod.test/y"), entry(1, "{{host}}/x", "https://prod.test/x")];

    expect(compareTarget(entries, 2, undefined, true)).toEqual({ entry: entries[0] });
  });

  it("isn't another request's entry that was sent to the same URL", () => {
    const entries = [entry(2, "{{a}}/x", "https://api.test/x"), entry(1, "{{b}}/x", "https://api.test/x")];

    expect(compareTarget(entries, 1, undefined, true)).toBeUndefined();
  });

  it("follows a named request whose URL changed, and not one of the same name in another file", () => {
    const entries = [
      entry(3, "{{host}}/x", "https://api.test/x", "pets", "other.http"),
      entry(2, "{{host}}/x?page=2", "https://api.test/x?page=2", "pets"),
      entry(1, "{{host}}/x", "https://api.test/x", "pets"),
    ];

    expect(compareTarget(entries, 2, undefined, true)).toEqual({ entry: entries[1] });
  });
});

describe("historyLinkKey", () => {
  it("is the same for a request and the entries sent from it, by the rule the shell lists them by", () => {
    const req = { ...newRequest("List"), method: "GET", url: "{{host}}/pets" };
    const sent: HistorySummary["link"] = { file: "api/pets.http", name: null, method: "GET", url: "{{host}}/pets" };
    const key = historyLinkKey(sent.file, sent);

    expect(historyLinkKey("api/pets.http", historyLink("/ws/api/pets.http", req))).toBe(key);
    expect(historyLinkKey(sent.file, { ...sent, url: "{{host}}/owners" })).not.toBe(key);
    expect(historyLinkKey(sent.file, { ...sent, name: "pets", url: "{{host}}/owners" })).toBe(historyLinkKey(sent.file, { ...sent, name: "pets" }));
  });
});
