// The phases of a response's final request, for the Timing tab's waterfall and
// the Request tab's timing line. The core reports a phase only if it was
// measured, so a missing one (DNS and connect on a reused connection) is left
// out rather than shown as zero.
import { formatDuration } from "./http";
import type { HttpResponse } from "./types";

export interface Phase {
  key: "dns" | "connect" | "ttfb" | "download";
  label: string;
  ms: number;
  /** When the phase began, in ms from the start of the send. */
  start: number;
}

/**
 * The measured phases in order. They run back to back and end with the total;
 * any time before the first one went on earlier hops (redirects).
 */
export function timingPhases(res: Pick<HttpResponse, "timings" | "timeMs" | "url">): Phase[] {
  const t = res.timings;
  const tls = res.url.toLowerCase().startsWith("https:");
  const measured: [Phase["key"], string, number | undefined][] = [
    ["dns", "DNS lookup", t.dns],
    ["connect", tls ? "Connect + TLS" : "Connect", t.connect],
    ["ttfb", "Waiting (TTFB)", t.ttfb],
    ["download", "Content download", t.download],
  ];
  const present = measured.filter((m): m is [Phase["key"], string, number] => m[2] !== undefined);
  let start = Math.max(0, res.timeMs - present.reduce((sum, [, , ms]) => sum + ms, 0));
  return present.map(([key, label, ms]) => {
    const phase = { key, label, ms, start };
    start += ms;
    return phase;
  });
}

/** A phase's duration: one decimal below 10 ms, where whole milliseconds would read as 0. */
export function formatPhase(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : formatDuration(ms);
}

/** "including 2 redirects", or "" when there were none. */
export function redirectNote(redirects: number): string {
  return redirects ? `including ${redirects} redirect${redirects === 1 ? "" : "s"}` : "";
}
