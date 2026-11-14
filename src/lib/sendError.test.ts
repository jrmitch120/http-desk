import { describe, expect, it, vi } from "vitest";
import { describeSendError, sendErrorFix, toSendError } from "./sendError";
import type { SendError, TlsReason } from "./types";

type Unsent<T> = T extends unknown ? Omit<T, "message"> : never;
const err = (e: Unsent<SendError>): SendError => ({ message: "chain", ...e });

describe("send error hints", () => {
  it("names the host that didn't resolve", () => {
    expect(describeSendError(err({ kind: "dns", details: { host: "api.exmaple.com" } }))).toEqual({
      heading: "Host not found",
      hint: "Couldn't find host api.exmaple.com. Check the URL or the selected environment.",
    });
  });

  it("says nothing is listening on a refused host and port", () => {
    expect(describeSendError(err({ kind: "refused", details: { host: "localhost", port: 8080 } })).hint).toBe(
      "Nothing is listening on localhost:8080. Is the server running?",
    );
  });

  it("says the server closed a reset connection", () => {
    expect(describeSendError(err({ kind: "reset", details: { host: "localhost", port: 8080 } })).hint).toBe("The server closed the connection.");
  });

  it("explains the certificate problem and points to the TLS settings", () => {
    const hint = (reason: TlsReason) => describeSendError(err({ kind: "tls", details: { reason } })).hint!;
    expect(hint("selfSigned")).toMatch(/^The server's certificate is self-signed/);
    expect(hint("expired")).toMatch(/^The server's certificate has expired/);
    expect(hint("wrongHost")).toMatch(/^The server's certificate is for a different host/);
    expect(hint("unknownIssuer")).toMatch(/^The server's certificate was issued by an authority that isn't trusted/);
    for (const r of ["selfSigned", "expired", "wrongHost", "unknownIssuer", "other"] as const) {
      expect(hint(r)).toContain("Settings → TLS");
      expect(hint(r)).toContain("SSLConfiguration");
    }
  });

  it("says which timeout fired and its value", () => {
    expect(describeSendError(err({ kind: "timeoutIdle", details: { timeoutMs: 200 } })).hint).toBe(
      "The idle timeout fired: no data arrived for 200 ms.",
    );
    expect(describeSendError(err({ kind: "timeoutConnect", details: { timeoutMs: 10_000 } })).hint).toBe(
      "The connection timeout fired: couldn't connect within 10 s.",
    );
    expect(describeSendError(err({ kind: "timeoutIdle", details: { timeoutMs: 120_000 } })).hint).toContain("2 min");
  });

  it("names the undefined variables", () => {
    expect(describeSendError(err({ kind: "unresolvedVariable", details: { names: ["scheme", "host"] } })).hint).toBe(
      "Not defined: scheme, host. Choose an environment that defines them.",
    );
  });

  it("names a circular reference in the URL by the chain followed, not as undefined", () => {
    const e = err({ kind: "circularVariable", details: { chains: [["baseUrl", "host", "api", "host"]] } });
    expect(describeSendError(e)).toEqual({
      heading: "Circular variable in the URL",
      hint: "Change a value in baseUrl → host → api → host so the chain doesn't come back to host.",
    });
    expect(sendErrorFix(e)).toBeNull();
  });

  it("tells a Request variable of a request never sent apart from an undefined one", () => {
    expect(describeSendError(err({ kind: "unsentRequest", details: { names: ["login"] } }))).toEqual({
      heading: "Request not sent in this Session",
      hint: "This request reads the response of `login`, so send `login` first. Nothing is sent on its own.",
    });
    expect(describeSendError(err({ kind: "unsentRequest", details: { names: ["login", "profile"] } })).hint).toBe(
      "This request reads the responses of `login` and `profile`, so send them first. Nothing is sent on its own.",
    );
  });

  it("names the exchange a Request variable's path matched nothing in, and when it arrived", () => {
    const received = new Date(2026, 10, 13, 9, 5, 7).toISOString();
    const e = err({ kind: "unmatchedPath", details: { paths: [{ reference: "login.response.body.$.tok", request: "login", received, reason: "`$.tok` matches nothing" }] } });
    expect(describeSendError(e)).toEqual({
      heading: "A Request variable matched nothing",
      hint: `Looked in the latest exchange of \`login\`, received at ${new Date(received).toLocaleTimeString()}. Check the path, or send \`login\` again if its response has changed.`,
    });
    expect(sendErrorFix(e)).toBeNull();
  });

  it("adds nothing to an invalid URL or an unreadable file: the message says it all", () => {
    expect(describeSendError(err({ kind: "invalidUrl", details: { url: "http://[x", reason: "invalid IPv6" } })).hint).toBeNull();
    expect(describeSendError(err({ kind: "file", details: { path: "/a.json", reason: "not found" } })).hint).toBeNull();
  });

  it("says a failed pre-request script stopped the send, at which line", () => {
    const e = { kind: "preRequestScript", message: "ReferenceError: sign is not defined (line 3)", details: { line: 3 } } as const;
    expect(describeSendError(e)).toEqual({
      heading: "Pre-request script failed",
      hint: "Nothing was sent. The error is at line 3 of the pre-request script.",
    });
    expect(describeSendError({ ...e, details: { line: null } }).hint).toBe("Nothing was sent.");
    expect(toSendError(e)).toBe(e);
    expect(sendErrorFix(e)).toBeNull();
  });

  it("keeps the general hint for other errors only", () => {
    const general = /Check the URL, the selected environment/;
    expect(describeSendError(err({ kind: "other", details: null }))).toEqual({
      heading: "Could not send request",
      hint: "Check the URL, the selected environment, and that the server is reachable.",
    });
    const others: SendError[] = [
      err({ kind: "dns", details: { host: "h" } }),
      err({ kind: "refused", details: { host: "h", port: 1 } }),
      err({ kind: "reset", details: { host: "h", port: 1 } }),
      err({ kind: "tls", details: { reason: "other" } }),
      err({ kind: "timeoutIdle", details: { timeoutMs: 1 } }),
      err({ kind: "timeoutConnect", details: { timeoutMs: 1 } }),
      err({ kind: "invalidUrl", details: { url: "u", reason: "r" } }),
      err({ kind: "unresolvedVariable", details: { names: ["a"] } }),
      err({ kind: "circularVariable", details: { chains: [["a", "a"]] } }),
      err({ kind: "file", details: { path: "p", reason: "r" } }),
      err({ kind: "preRequestScript", details: { line: 1 } }),
    ];
    for (const e of others) expect(describeSendError(e).hint ?? "", e.kind).not.toMatch(general);
  });
});

describe("toSendError", () => {
  it("passes a classified error through", () => {
    const e = err({ kind: "dns", details: { host: "h" } });
    expect(toSendError(e)).toBe(e);
  });

  it("doesn't take an unknown kind for a classified error", () => {
    expect(toSendError({ kind: "toString", message: "m" })).toMatchObject({ kind: "other", details: null });
  });

  it("treats anything else as other, with its text as the message", () => {
    expect(toSendError("Request cancelled")).toEqual({ kind: "other", message: "Request cancelled", details: null });
    expect(toSendError(new Error("boom"))).toEqual({ kind: "other", message: "boom", details: null });
  });
});

describe("sendErrorFix", () => {
  const actions = () => ({ openSettings: vi.fn(), showRequestSettings: vi.fn(), chooseEnvironment: vi.fn(), sendFirst: vi.fn() });

  it("opens the TLS settings for a TLS error", () => {
    const a = actions();
    const fix = sendErrorFix(err({ kind: "tls", details: { reason: "selfSigned" } }))!;
    expect(fix.label).toBe("Open Settings → TLS");
    fix.run(a, "t1");
    expect(a.openSettings).toHaveBeenCalledWith("tls");
  });

  it("opens the request's own Settings for either timeout", () => {
    for (const kind of ["timeoutIdle", "timeoutConnect"] as const) {
      const a = actions();
      const fix = sendErrorFix(err({ kind, details: { timeoutMs: 1 } }))!;
      expect(fix.label).toBe("Open request Settings");
      fix.run(a, "t1");
      expect(a.showRequestSettings).toHaveBeenCalledWith("t1");
    }
  });

  it("opens the environment picker for undefined variables", () => {
    const a = actions();
    const fix = sendErrorFix(err({ kind: "unresolvedVariable", details: { names: ["x"] } }))!;
    expect(fix.label).toBe("Choose environment");
    fix.run(a, "t1");
    expect(a.chooseEnvironment).toHaveBeenCalled();
  });

  it("sends the first unsent request for a Request variable of one never sent", () => {
    const a = actions();
    const fix = sendErrorFix(err({ kind: "unsentRequest", details: { names: ["login", "profile"] } }))!;
    expect(fix.label).toBe("Send `login` first");
    fix.run(a, "t1");
    expect(a.sendFirst).toHaveBeenCalledWith("t1", "login");
  });

  it("offers nothing but Retry for the other kinds", () => {
    expect(sendErrorFix(err({ kind: "dns", details: { host: "h" } }))).toBeNull();
    expect(sendErrorFix(err({ kind: "other", details: null }))).toBeNull();
  });
});
