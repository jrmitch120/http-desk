import { describe, expect, it } from "vitest";
import { readingCard, workspaceFile } from "./exchanges";

const received = "2026-11-13T09:05:07.000Z";
const at = new Date(received).toLocaleTimeString();

describe("a Request variable's hover", () => {
  it("shows the value, and the exchange it came from: the request, its file, when it arrived and its status", () => {
    expect(readingCard({ state: "value", request: "login", status: 200, received, value: "abc123" }, "api/auth.http")).toEqual({
      value: "abc123",
      bad: false,
      source: `from the latest exchange of login in api/auth.http, received at ${at} (200)`,
    });
  });

  it("says when its request hasn't been sent", () => {
    expect(readingCard({ state: "unsent", request: "login" }, "api/auth.http")).toEqual({
      value: "Not sent yet — send login first",
      bad: true,
      source: "from login in api/auth.http, not sent in this Session",
    });
  });

  it("says when its path matches nothing, and why", () => {
    expect(readingCard({ state: "unmatched", request: "login", status: 404, received, reason: "`$.tok` matches nothing" }, "auth.http")).toEqual({
      value: "Path matches nothing — `$.tok` matches nothing",
      bad: true,
      source: `from the latest exchange of login in auth.http, received at ${at} (404)`,
    });
  });
});

describe("a file as the Session panel names it", () => {
  it("is relative to the workspace root", () => {
    expect(workspaceFile("/ws", "/ws/api/pets.http")).toBe("api/pets.http");
    expect(workspaceFile("C:\\ws", "C:\\ws\\api\\pets.http")).toBe("api/pets.http");
  });

  it("is the whole path outside the workspace, or with none open", () => {
    expect(workspaceFile("/ws", "/other/pets.http")).toBe("/other/pets.http");
    expect(workspaceFile(null, "/ws/pets.http")).toBe("/ws/pets.http");
    expect(workspaceFile("/ws", "/wsx/pets.http")).toBe("/wsx/pets.http");
  });
});
