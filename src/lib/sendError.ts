// Explaining a failed send. The core classifies the error and owns its
// message; the heading, the hint ("what to do about it") and the fix-it button
// are chosen here, by kind.

import { errorMessage } from "./api";
import { joinAnd } from "./http";
import type { app } from "./store.svelte";
import type { SendError, SendErrorKind, TlsReason } from "./types";

/** The error panel's heading for each kind; its keys are every kind the core sends. */
const HEADINGS: Record<SendErrorKind, string> = {
  dns: "Host not found",
  refused: "Connection refused",
  reset: "Connection reset",
  tls: "Secure connection failed",
  timeoutIdle: "Timed out",
  timeoutConnect: "Timed out",
  invalidUrl: "Invalid URL",
  unresolvedVariable: "Undefined variables in the URL",
  circularVariable: "Circular variable in the URL",
  unsentRequest: "Request not sent in this Session",
  unmatchedPath: "A Request variable matched nothing",
  file: "Couldn't read a file",
  other: "Could not send request",
};

/** A classified error as it is, anything else (a join error, a mock's string) as `other`. */
export function toSendError(e: unknown): SendError {
  const maybe = e as { kind?: unknown; message?: unknown } | null;
  if (maybe && typeof maybe === "object" && typeof maybe.kind === "string" && Object.hasOwn(HEADINGS, maybe.kind) && typeof maybe.message === "string") {
    return e as SendError;
  }
  return { kind: "other", message: errorMessage(e), details: null };
}

const TLS_REASONS: Record<TlsReason, string> = {
  selfSigned: "The server's certificate is self-signed, so it isn't trusted.",
  expired: "The server's certificate has expired.",
  wrongHost: "The server's certificate is for a different host name.",
  unknownIssuer: "The server's certificate was issued by an authority that isn't trusted.",
  other: "The secure connection couldn't be set up.",
};

/** Mirrors the core's wording for timeouts: "200 ms", "10 s", "2 min". */
function humanMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

/** The hint under the message, or `null` when the message says it all. */
function hint(err: SendError): string | null {
  switch (err.kind) {
    case "dns":
      return `Couldn't find host ${err.details.host}. Check the URL or the selected environment.`;
    case "refused":
      return `Nothing is listening on ${err.details.host}:${err.details.port}. Is the server running?`;
    case "reset":
      return "The server closed the connection.";
    case "tls":
      return `${TLS_REASONS[err.details.reason] ?? TLS_REASONS.other} Certificate options are in Settings → TLS and in the environment's SSLConfiguration.`;
    case "timeoutIdle":
      return `The idle timeout fired: no data arrived for ${humanMs(err.details.timeoutMs)}.`;
    case "timeoutConnect":
      return `The connection timeout fired: couldn't connect within ${humanMs(err.details.timeoutMs)}.`;
    case "unresolvedVariable":
      return `Not defined: ${err.details.names.join(", ")}. Choose an environment that defines them.`;
    case "circularVariable":
      return err.details.chains
        .map((chain) => `Change a value in ${chain.join(" → ")} so the chain doesn't come back to ${chain[chain.length - 1]}.`)
        .join(" ");
    case "unsentRequest": {
      const names = err.details.names.map((n) => `\`${n}\``);
      return names.length === 1
        ? `This request reads the response of ${names[0]}, so send ${names[0]} first. Nothing is sent on its own.`
        : `This request reads the responses of ${joinAnd(names)}, so send them first. Nothing is sent on its own.`;
    }
    case "unmatchedPath":
      return err.details.paths
        .filter((p, i, all) => all.findIndex((q) => q.request === p.request) === i)
        .map((p) => {
          const at = new Date(p.received).toLocaleTimeString();
          return `Looked in the latest exchange of \`${p.request}\`, received at ${at}. Check the path, or send \`${p.request}\` again if its response has changed.`;
        })
        .join(" ");
    case "invalidUrl":
    case "file":
      return null;
    case "other":
      return "Check the URL, the selected environment, and that the server is reachable.";
  }
}

/** The error panel's heading, and the hint under the message (`null` when the message says it all). */
export function describeSendError(err: SendError): { heading: string; hint: string | null } {
  return { heading: HEADINGS[err.kind], hint: hint(err) };
}

/** The store actions a fix-it button can take. */
export type FixActions = Pick<typeof app, "openSettings" | "showRequestSettings" | "chooseEnvironment" | "sendFirst">;

/** A fix-it button: its label, and what clicking it does for the editor tab `tabId`. */
export interface SendErrorFix {
  label: string;
  run: (actions: FixActions, tabId: string) => void;
}

/**
 * The fix-it button for an error, or `null` when Retry is all there is. A TLS
 * error points at the certificate settings, never at a switch that turns
 * verification off.
 */
export function sendErrorFix(err: SendError): SendErrorFix | null {
  switch (err.kind) {
    case "tls":
      return { label: "Open Settings → TLS", run: (actions) => actions.openSettings("tls") };
    case "timeoutIdle":
    case "timeoutConnect":
      return { label: "Open request Settings", run: (actions, tabId) => actions.showRequestSettings(tabId) };
    case "unresolvedVariable":
      return { label: "Choose environment", run: (actions) => actions.chooseEnvironment() };
    case "unsentRequest": {
      // One at a time: the report comes back naming the next until none is left.
      const name = err.details.names[0];
      return { label: `Send \`${name}\` first`, run: (actions, tabId) => actions.sendFirst(tabId, name) };
    }
    default:
      return null;
  }
}
