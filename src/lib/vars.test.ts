import { describe, expect, it } from "vitest";
import { makeVarProvider, varSegments } from "./vars";

const env = {
  baseUrl: { value: "http://127.0.0.1:8765", secret: false, source: "local" },
  token: { value: "dev-token-123", secret: true, source: "local" },
};
const provider = makeVarProvider(env, [{ name: "petId", value: "1" }], "local");

describe("varSegments (the static rendering of a variable-aware field)", () => {
  it("splits text into plain runs and variables, each variable classed by its state", () => {
    expect(varSegments("Bearer {{token}} for {{petId}}, {{ nope }} at {{$uuid}}!", provider)).toEqual([
      { text: "Bearer " },
      { text: "{{token}}", name: "token", cls: "cm-var cm-var-ok cm-var-secret" },
      { text: " for " },
      { text: "{{petId}}", name: "petId", cls: "cm-var cm-var-ok" },
      { text: ", " },
      { text: "{{ nope }}", name: "nope", cls: "cm-var cm-var-bad" },
      { text: " at " },
      { text: "{{$uuid}}", name: "$uuid", cls: "cm-var cm-var-dyn" },
      { text: "!" },
    ]);
  });

  it("is one plain run without variables, and nothing for empty text", () => {
    expect(varSegments("application/json", provider)).toEqual([{ text: "application/json" }]);
    expect(varSegments("", provider)).toEqual([]);
  });

  it("leaves variables plain when there is no provider", () => {
    expect(varSegments("a {{token}}", null)).toEqual([{ text: "a {{token}}" }]);
  });
});
