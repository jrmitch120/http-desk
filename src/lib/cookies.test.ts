import { describe, expect, it } from "vitest";
import { cookieExpiry } from "./cookies";
import type { ResponseCookie } from "./types";

const cookie = (c: Partial<ResponseCookie>): ResponseCookie => ({
  name: "a", value: "1", domain: null, path: null, expires: null, maxAge: null, secure: false, httpOnly: false,
  sameSite: null, url: "https://example.com/", raw: "a=1", parseError: null, ...c,
});

describe("cookieExpiry", () => {
  it("calls a cookie without Expires or Max-Age a session cookie", () => {
    expect(cookieExpiry(cookie({}))).toBe("Session");
  });

  it("shows Expires as an HTTP date in GMT", () => {
    expect(cookieExpiry(cookie({ expires: "2026-12-01T00:00:00Z" }))).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
  });

  it("shows Max-Age in the largest whole unit, and prefers it over Expires", () => {
    expect(cookieExpiry(cookie({ maxAge: 45 }))).toBe("Max-Age 45 s");
    expect(cookieExpiry(cookie({ maxAge: 90 }))).toBe("Max-Age 90 s");
    expect(cookieExpiry(cookie({ maxAge: 300 }))).toBe("Max-Age 5 min");
    expect(cookieExpiry(cookie({ maxAge: 3600, expires: "2026-12-01T00:00:00Z" }))).toBe("Max-Age 1 h");
    expect(cookieExpiry(cookie({ maxAge: 30 * 86400 }))).toBe("Max-Age 30 d");
  });

  it("calls Max-Age 0 expired: the server is deleting the cookie", () => {
    expect(cookieExpiry(cookie({ maxAge: 0 }))).toBe("Expired (Max-Age 0)");
  });

  it("says nothing for a cookie that didn't parse", () => {
    expect(cookieExpiry(cookie({ parseError: "bad" }))).toBe("");
  });
});
