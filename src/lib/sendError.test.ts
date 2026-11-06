import { describe, expect, it } from "vitest";
import { describeSendError, toSendError } from "./sendError";
import type { SendError, SendErrorKind } from "./types";

const err = (kind: SendErrorKind, details: SendError["details"] = null): SendError => ({ kind, message: "chain", details });

describe("send error hints", () => {
  it("names the host that didn't resolve", () => {
    expect(describeSendError(err("dns", { host: "api.exmaple.com" }))).toEqual({
      heading: "Host not found",
      hint: "Couldn't find host api.exmaple.com. Check the URL or the selected environment.",
    });
  });

  it("says nothing is listening on a refused host and port", () => {
    expect(describeSendError(err("refused", { host: "localhost", port: 8080 })).hint).toBe(
      "Nothing is listening on localhost:8080. Is the server running?",
    );
  });

  it("says the server closed a reset connection", () => {
    expect(describeSendError(err("reset", { host: "localhost", port: 8080 })).hint).toBe("The server closed the connection.");
  });

  it("explains the certificate problem and points to the TLS settings", () => {
    const hint = (reason: string) => describeSendError(err("tls", { reason } as SendError["details"])).hint!;
    expect(hint("selfSigned")).toMatch(/^The server's certificate is self-signed/);
    expect(hint("expired")).toMatch(/^The server's certificate has expired/);
    expect(hint("wrongHost")).toMatch(/^The server's certificate is for a different host/);
    expect(hint("unknownIssuer")).toMatch(/^The server's certificate was issued by an authority that isn't trusted/);
    for (const r of ["selfSigned", "expired", "wrongHost", "unknownIssuer", "other"]) {
      expect(hint(r)).toContain("Settings → TLS");
      expect(hint(r)).toContain("SSLConfiguration");
    }
  });

  it("says which timeout fired and its value", () => {
    expect(describeSendError(err("timeoutIdle", { timeoutMs: 200 })).hint).toBe(
      "The idle timeout fired: no data arrived for 200 ms.",
    );
    expect(describeSendError(err("timeoutConnect", { timeoutMs: 10_000 })).hint).toBe(
      "The connection timeout fired: couldn't connect within 10 s.",
    );
    expect(describeSendError(err("timeoutIdle", { timeoutMs: 120_000 })).hint).toContain("2 min");
  });

  it("names the undefined variables", () => {
    expect(describeSendError(err("unresolvedVariable", { names: ["scheme", "host"] })).hint).toBe(
      "Not defined: scheme, host. Choose an environment that defines them.",
    );
  });

  it("adds nothing to an invalid URL or an unreadable file: the message says it all", () => {
    expect(describeSendError(err("invalidUrl", { url: "http://[x", reason: "invalid IPv6" })).hint).toBeNull();
    expect(describeSendError(err("file", { path: "/a.json", reason: "not found" })).hint).toBeNull();
  });

  it("keeps the general hint for other errors only", () => {
    const general = /Check the URL, the selected environment/;
    expect(describeSendError(err("other"))).toEqual({
      heading: "Could not send request",
      hint: "Check the URL, the selected environment, and that the server is reachable.",
    });
    const others: SendError[] = [
      err("dns", { host: "h" }),
      err("refused", { host: "h", port: 1 }),
      err("reset", { host: "h", port: 1 }),
      err("tls", { reason: "other" }),
      err("timeoutIdle", { timeoutMs: 1 }),
      err("timeoutConnect", { timeoutMs: 1 }),
      err("invalidUrl", { url: "u", reason: "r" }),
      err("unresolvedVariable", { names: ["a"] }),
      err("file", { path: "p", reason: "r" }),
    ];
    for (const e of others) expect(describeSendError(e).hint ?? "", e.kind).not.toMatch(general);
  });
});

describe("toSendError", () => {
  it("passes a classified error through", () => {
    const e = err("dns", { host: "h" });
    expect(toSendError(e)).toBe(e);
  });

  it("treats anything else as other, with its text as the message", () => {
    expect(toSendError("Request cancelled")).toEqual({ kind: "other", message: "Request cancelled", details: null });
    expect(toSendError(new Error("boom"))).toEqual({ kind: "other", message: "boom", details: null });
  });
});
