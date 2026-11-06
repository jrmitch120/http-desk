import { describe, expect, it } from "vitest";
import { explainStatus } from "./status";

describe("explainStatus", () => {
  it("explains a listed status code with its standard name", () => {
    expect(explainStatus(422)).toBe("422 Unprocessable Content: the server understood the request but the content was invalid");
    expect(explainStatus(404, "Not Found")).toBe("404 Not Found: the server has nothing at this URL");
  });

  it("uses the standard name even when the server sends its own reason phrase", () => {
    expect(explainStatus(200, "Everything is fine")).toMatch(/^200 OK: /);
  });

  it("falls back to the class for an unlisted code, keeping the server's reason phrase", () => {
    expect(explainStatus(499, "Client Closed Request")).toBe("499 Client Closed Request: 4xx client error");
    expect(explainStatus(299)).toBe("299: 2xx success");
    expect(explainStatus(599, "")).toBe("599: 5xx server error");
    expect(explainStatus(150)).toBe("150: 1xx informational");
    expect(explainStatus(399)).toBe("399: 3xx redirection");
  });

  it("calls a code outside 100-599 non-standard", () => {
    expect(explainStatus(999)).toBe("999: non-standard status code");
  });
});
