import { describe, expect, it } from "vitest";
import { explainHeader, filterHeaders, headersText } from "./headers";

const headers: [string, string][] = [
  ["Content-Type", "application/json"],
  ["Cache-Control", "max-age=60"],
  ["x-cache", "HIT"],
  ["ETag", '"abc"'],
];

describe("filterHeaders", () => {
  it("keeps headers whose name contains the query, ignoring case, in response order", () => {
    expect(filterHeaders(headers, "CACHE")).toEqual([
      ["Cache-Control", "max-age=60"],
      ["x-cache", "HIT"],
    ]);
  });

  it("matches names only, never values", () => {
    expect(filterHeaders(headers, "json")).toEqual([]);
  });

  it("an empty or blank query keeps every header", () => {
    expect(filterHeaders(headers, "")).toEqual(headers);
    expect(filterHeaders(headers, "  ")).toEqual(headers);
  });
});

describe("headersText", () => {
  it("writes one `Name: value` line per header, in response order, repeats included", () => {
    const list: [string, string][] = [
      ["Set-Cookie", "a=1"],
      ["Content-Type", "text/plain"],
      ["Set-Cookie", "b=2"],
    ];
    expect(headersText(list)).toBe("Set-Cookie: a=1\nContent-Type: text/plain\nSet-Cookie: b=2");
  });
});

describe("explainHeader", () => {
  it("explains caching, CORS and rate-limit headers named in the spec, whatever their case", () => {
    const names = ["Cache-Control", "ETag", "Expires", "Last-Modified", "Age", "Vary", "Access-Control-Allow-Origin", "access-control-allow-methods", "RateLimit-Remaining", "x-ratelimit-limit", "Retry-After"];
    for (const name of names) expect(explainHeader(name), name).not.toBeNull();
  });

  it("puts each header in its group", () => {
    expect(explainHeader("cache-control")?.group).toBe("Caching");
    expect(explainHeader("Access-Control-Max-Age")?.group).toBe("CORS");
    expect(explainHeader("Retry-After")?.group).toBe("Rate limit");
  });

  it("explains Cache-Control in terms of its directives", () => {
    expect(explainHeader("CACHE-CONTROL")?.text).toMatch(/max-age/);
  });

  it("leaves other headers unexplained", () => {
    expect(explainHeader("Content-Type")).toBeNull();
    expect(explainHeader("x-powered-by")).toBeNull();
  });
});
