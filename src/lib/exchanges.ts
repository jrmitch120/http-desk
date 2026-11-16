// Named requests' latest exchanges in the Session, as the app shows them: a Request
// variable's hover (what it reads now, and from which exchange) and the Session
// panel's Named exchanges.
import type { RequestVariableReading } from "./types";

/** A Request variable's hover card, below its name: its value (or why there's none) and where it comes from. */
export interface ReadingCard {
  value: string;
  /** No value: a send would be blocked. */
  bad: boolean;
  source: string;
}

/** What a Request variable's hover says it reads (`reading`), for a request in `file` (as `workspaceFile` names it). */
export function readingCard(reading: RequestVariableReading, file: string): ReadingCard {
  const { request } = reading;
  if (reading.state === "unsent") {
    return { value: `Not sent yet — send ${request} first`, bad: true, source: `from ${request} in ${file}, not sent in this Session` };
  }
  const source = `from the latest exchange of ${request} in ${file}, received at ${receivedAt(reading.received)} (${reading.status})`;
  if (reading.state === "unmatched") return { value: `Path matches nothing — ${reading.reason}`, bad: true, source };
  return { value: reading.value, bad: false, source };
}

/** When an exchange's response arrived (RFC 3339), as the time of day. */
export function receivedAt(received: string): string {
  return new Date(received).toLocaleTimeString();
}

/** `path` relative to workspace `root`, with `/`; the whole path outside it or with no workspace open. */
export function workspaceFile(root: string | null, path: string): string {
  const slashed = (p: string) => p.replace(/\\/g, "/");
  const [r, p] = [root && slashed(root).replace(/\/$/, ""), slashed(path)];
  return r && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : path;
}
