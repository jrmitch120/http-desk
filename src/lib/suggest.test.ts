import { describe, expect, it } from "vitest";
import { matchSuggestions } from "./suggest";

const HEADERS = ["Accept", "Accept-Encoding", "Authorization", "Content-Type", "Content-Length", "X-Content-Type-Options", "Connection"];

describe("matchSuggestions", () => {
  it("matches the start of a name, ignoring case, in list order", () => {
    expect(matchSuggestions("cont", HEADERS).map((m) => m.value)).toEqual(["Content-Type", "Content-Length", "X-Content-Type-Options"]);
  });

  it("lists names that start with the text before names that only contain it", () => {
    expect(matchSuggestions("type", HEADERS).map((m) => m.value)).toEqual(["Content-Type", "X-Content-Type-Options"]);
    expect(matchSuggestions("content", ["X-Content-Type-Options", "Content-Type"]).map((m) => m.value)).toEqual([
      "Content-Type",
      "X-Content-Type-Options",
    ]);
  });

  it("reports where the text matched, so the list can mark it", () => {
    expect(matchSuggestions("TYPE", ["Content-Type"])).toEqual([{ value: "Content-Type", from: 8, to: 12 }]);
    expect(matchSuggestions("acc", ["Accept"])).toEqual([{ value: "Accept", from: 0, to: 3 }]);
  });

  it("suggests every name for empty text", () => {
    expect(matchSuggestions("", ["B", "A"])).toEqual([
      { value: "B", from: 0, to: 0 },
      { value: "A", from: 0, to: 0 },
    ]);
  });

  it("suggests nothing once the text is exactly the only match", () => {
    expect(matchSuggestions("Authorization", HEADERS)).toEqual([]);
    expect(matchSuggestions("Accept", HEADERS).map((m) => m.value)).toEqual(["Accept", "Accept-Encoding"]);
    // A different case is still worth offering: accepting fixes it.
    expect(matchSuggestions("authorization", HEADERS).map((m) => m.value)).toEqual(["Authorization"]);
  });

  it("ignores surrounding spaces in the text", () => {
    expect(matchSuggestions("  conn ", HEADERS).map((m) => m.value)).toEqual(["Connection"]);
  });
});
