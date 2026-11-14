import { describe, expect, it } from "vitest";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { scriptCompletion } from "./scriptApi";
import type { ScriptKind } from "./scripts";

/** What completion offers with the caret at `|` in `text`. */
function offered(text: string, kind: ScriptKind = "handler", explicit = false) {
  const pos = text.indexOf("|");
  const state = EditorState.create({ doc: text.replace("|", ""), extensions: javascript() });
  const result = scriptCompletion(kind)(new CompletionContext(state, pos, explicit)) as CompletionResult | null;
  return result ? { from: result.from, labels: result.options.map((o) => o.label) } : null;
}

describe("script completion", () => {
  it("offers the members of client and response that HttpDesk implements", () => {
    expect(offered("client.|")?.labels).toEqual(expect.arrayContaining(["test", "assert"]));
    expect(offered("response.|")?.labels).toEqual(expect.arrayContaining(["status", "body", "headers", "contentType"]));
    expect(offered("response.headers.val|")).toEqual({ from: 17, labels: expect.arrayContaining(["valueOf", "valuesOf"]) });
  });

  it("never offers a JetBrains API HttpDesk doesn't implement", () => {
    expect(offered("client.|")?.labels).not.toContain("exit");
    expect(offered("crypto.|")).toBeNull();
    expect(offered("|", "handler", true)?.labels).not.toEqual(expect.arrayContaining(["crypto", "jsonPath", "xpath", "$random"]));
  });

  it("offers the API's roots by name, and no response in a pre-request script", () => {
    expect(offered("cli|")?.labels).toContain("client");
    expect(offered("resp|")?.labels).toContain("response");
    expect(offered("resp|", "pre-request")?.labels ?? []).not.toContain("response");
    expect(offered("response.|", "pre-request")).toBeNull();
  });

  it("stays out of strings and comments, and of members of other objects", () => {
    expect(offered('client.test("client.|')).toBeNull();
    expect(offered("// client.|")).toBeNull();
    expect(offered("foo.client.|")).toBeNull();
  });
});
