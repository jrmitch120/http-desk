import { describe, expect, it } from "vitest";
import { newRequest } from "./http";
import { addScript, removeScript, requestScripts, scriptBodyProblem, setScriptBody } from "./scripts";
import type { Request } from "./types";

function request(preScript: string | null, responseHandler: string | null): Request {
  return { ...newRequest(), preScript, responseHandler };
}

const MULTI = `> {%
    client.test("Request executed successfully", function() {
        client.assert(response.status === 200, "Response status is not 200");
    });
%}`;

describe("a request's scripts", () => {
  it("lists pre-request scripts, then handlers, with inline bodies, file paths, and no redirects", () => {
    const req = request("< {% request.variables.set(\"a\", \"1\") %}\n< ./sign.js", `${MULTI}\n> ./check.js\n>> ./out.json`);
    expect(requestScripts(req)).toEqual([
      { kind: "pre-request", index: 0, form: "inline", body: 'request.variables.set("a", "1")' },
      { kind: "pre-request", index: 1, form: "file", path: "./sign.js" },
      {
        kind: "handler",
        index: 0,
        form: "inline",
        body: '    client.test("Request executed successfully", function() {\n        client.assert(response.status === 200, "Response status is not 200");\n    });',
      },
      { kind: "handler", index: 1, form: "file", path: "./check.js" },
    ]);
  });

  it("has none when the request has neither", () => {
    expect(requestScripts(request(null, null))).toEqual([]);
    expect(requestScripts(request(null, ">> ./saved.json"))).toEqual([]);
  });

  it("editing a body changes only the text between {% and %}", () => {
    const req = request(null, `${MULTI}\n>>! ./report.json`);
    const [handler] = requestScripts(req);
    setScriptBody(req, handler, "    client.log(1);");
    expect(req.responseHandler).toBe("> {%\n    client.log(1);\n%}\n>>! ./report.json");
  });

  it("editing a one-line script keeps it on its line", () => {
    const req = request('< {% request.variables.set("a", "1") %}', '> {% client.test("ok", () => {}); %}\n> {% client.assert(true); %}');
    const [pre, , second] = requestScripts(req);
    setScriptBody(req, pre, 'request.variables.set("a", "2")');
    setScriptBody(req, second, "client.assert(false);");
    expect(req.preScript).toBe('< {% request.variables.set("a", "2") %}');
    expect(req.responseHandler).toBe('> {% client.test("ok", () => {}); %}\n> {% client.assert(false); %}');
  });

  it("adds an empty inline block in JetBrains form: handlers before any redirect, pre-request scripts last", () => {
    const req = request(null, null);
    addScript(req, "handler");
    addScript(req, "pre-request");
    expect(req.responseHandler).toBe("> {%\n\n%}");
    expect(req.preScript).toBe("< {%\n\n%}");
    expect(requestScripts(req).map((s) => s.form === "inline" && s.body)).toEqual(["", ""]);

    const [pre, handler] = requestScripts(req);
    setScriptBody(req, handler, '    client.test("ok", function () {});');
    setScriptBody(req, pre, "    const a = 1;");
    expect(req.responseHandler).toBe('> {%\n    client.test("ok", function () {});\n%}');
    expect(req.preScript).toBe("< {%\n    const a = 1;\n%}");

    const redirected = request("< ./sign.js", "> ./check.js\n>> ./out.json");
    addScript(redirected, "handler");
    addScript(redirected, "pre-request");
    expect(redirected.responseHandler).toBe("> ./check.js\n> {%\n\n%}\n>> ./out.json");
    expect(redirected.preScript).toBe("< ./sign.js\n< {%\n\n%}");
  });

  it("removing a script takes its lines out, and the last one leaves nothing", () => {
    const req = request("< {%\n  a();\n%}", `> {% one(); %}\n${MULTI}\n>> ./out.json`);
    const [pre, one] = requestScripts(req);
    removeScript(req, one);
    expect(req.responseHandler).toBe(`${MULTI}\n>> ./out.json`);
    removeScript(req, pre);
    expect(req.preScript).toBeNull();
    removeScript(req, requestScripts(req)[0]);
    expect(req.responseHandler).toBe(">> ./out.json");
  });

  it("flags a body that would end its block early", () => {
    expect(scriptBodyProblem('client.log("50%}")')).toMatch(/%}/);
    expect(scriptBodyProblem("client.log(1)")).toBeNull();
  });
});
