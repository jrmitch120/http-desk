// Explaining a failed send. The core classifies the error and owns its
// message; the heading and the hint ("what to do about it") are chosen here,
// by kind.

import { errorMessage } from "./api";
import type { SendError, SendErrorKind, TlsReason } from "./types";

const KINDS: SendErrorKind[] = [
  "dns",
  "refused",
  "reset",
  "tls",
  "timeoutIdle",
  "timeoutConnect",
  "invalidUrl",
  "unresolvedVariable",
  "file",
  "other",
];

/** A classified error as it is, anything else (a join error, a mock's string) as `other`. */
export function toSendError(e: unknown): SendError {
  const maybe = e as Partial<SendError> | null;
  if (maybe && typeof maybe === "object" && KINDS.includes(maybe.kind!) && typeof maybe.message === "string") {
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

/** The error panel's heading, and the hint under the message (`null` when the message says it all). */
export function describeSendError(err: SendError): { heading: string; hint: string | null } {
  const d = (err.details ?? {}) as Record<string, any>;
  switch (err.kind) {
    case "dns":
      return { heading: "Host not found", hint: `Couldn't find host ${d.host}. Check the URL or the selected environment.` };
    case "refused":
      return { heading: "Connection refused", hint: `Nothing is listening on ${d.host}:${d.port}. Is the server running?` };
    case "reset":
      return { heading: "Connection reset", hint: "The server closed the connection." };
    case "tls":
      return {
        heading: "Secure connection failed",
        hint: `${TLS_REASONS[d.reason as TlsReason] ?? TLS_REASONS.other} Certificate options are in Settings → TLS and in the environment's SSLConfiguration.`,
      };
    case "timeoutIdle":
      return { heading: "Timed out", hint: `The idle timeout fired: no data arrived for ${humanMs(d.timeoutMs)}.` };
    case "timeoutConnect":
      return { heading: "Timed out", hint: `The connection timeout fired: couldn't connect within ${humanMs(d.timeoutMs)}.` };
    case "invalidUrl":
      return { heading: "Invalid URL", hint: null };
    case "unresolvedVariable":
      return {
        heading: "Undefined variables in the URL",
        hint: `Not defined: ${(d.names as string[]).join(", ")}. Choose an environment that defines them.`,
      };
    case "file":
      return { heading: "Couldn't read a file", hint: null };
    case "other":
      return { heading: "Could not send request", hint: "Check the URL, the selected environment, and that the server is reachable." };
  }
}

/** What a fix-it button on the error panel opens. */
export type SendErrorFix = "tlsSettings" | "requestSettings" | "environment";

/**
 * The fix-it button for an error, or `null` when Retry is all there is. A TLS
 * error points at the certificate settings, never at a switch that turns
 * verification off.
 */
export function sendErrorFix(err: SendError): { fix: SendErrorFix; label: string } | null {
  switch (err.kind) {
    case "tls":
      return { fix: "tlsSettings", label: "Open Settings → TLS" };
    case "timeoutIdle":
    case "timeoutConnect":
      return { fix: "requestSettings", label: "Open request Settings" };
    case "unresolvedVariable":
      return { fix: "environment", label: "Choose environment" };
    default:
      return null;
  }
}
