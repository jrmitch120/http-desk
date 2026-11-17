// Compare's headers text (#158): header order doesn't show as a change, but values do.
import { describe, expect, it } from "vitest";
import { headersText } from "./compare";
import type { HttpResponse } from "./types";

const response = (headers: [string, string][]) => ({ httpVersion: "HTTP/1.1", status: 200, statusText: "OK", headers }) as HttpResponse;

describe("headersText", () => {
  it("is the status line, then the headers sorted by name, repeated ones in the order received", () => {
    const text = headersText({ label: "", response: response([["X-B", "1"], ["set-cookie", "a=1"], ["Content-Type", "text/plain"], ["Set-Cookie", "b=2"]]) });
    expect(text).toBe("HTTP/1.1 200 OK\ncontent-type: text/plain\nset-cookie: a=1\nset-cookie: b=2\nx-b: 1");
  });

  it("the same headers in another order and case give the same text", () => {
    const a = headersText({ label: "", response: response([["Date", "d"], ["ETag", '"v1"']]) });
    const b = headersText({ label: "", response: response([["etag", '"v1"'], ["date", "d"]]) });
    expect(a).toBe(b);
  });

  it("a side with no response says why", () => {
    expect(headersText({ label: "", response: null, error: "Connection refused" })).toBe("Error: Connection refused");
    expect(headersText({ label: "", response: null, cancelled: true })).toBe("Cancelled");
  });
});
