import type { RunItemState } from "./runner.svelte";

/**
 * A Run (GLOSSARY "Run") summed up, as both the bottom bar's Runner item and the
 * Runner panel show it, so the two never disagree.
 */
export interface RunSummary {
  /** "Run 2/12" while running; "Run: 11 passed" once finished; "Run stopped: 4/12" once stopped. */
  label: string;
  /** "· 1 failed" once any request has failed, else "": shown after the label, warning-toned. */
  failed: string;
  /** The label and the failed count as one line ("Run: 11 passed · 1 failed"), for text and accessible names. */
  text: string;
  /** The shares of all the run's requests (0 to 1) that passed, failed, and are being sent: the progress bar's fill. */
  passedShare: number;
  failedShare: number;
  sendingShare: number;
  /**
   * The compact form the bottom bar's Runner item shows (its tooltip and accessible
   * name use `text`). `label`: "▶ 3/10" while running, "✓ 8" once finished (the passed
   * count), "■ 2/5" once stopped. `failed`: "✕ 2" once an ended run has any failure,
   * else "" (mid-run, failures show only in the progress line); shown after the label,
   * warning-toned.
   */
  compact: { label: string; failed: string };
}

/**
 * Sums up a run from its requests' states and whether it's still running. Finished
 * requests are those that passed or failed; a run that ended with any request
 * cancelled or never reached (Stop, or Stop on first failure) was stopped.
 */
export function runSummary(items: readonly { state: RunItemState }[], running: boolean): RunSummary {
  const count = (state: RunItemState) => items.filter((i) => i.state === state).length;
  const [passed, failed, sending] = [count("passed"), count("failed"), count("sending")];
  const total = items.length;
  const finished = `${passed + failed}/${total}`;
  const stopped = !running && items.some((i) => i.state === "cancelled" || i.state === "notRun");
  const share = (n: number) => (total ? n / total : 0);
  const label = running ? `Run ${finished}` : stopped ? `Run stopped: ${finished}` : `Run: ${passed} passed`;
  const failedText = failed ? `· ${failed} failed` : "";
  return {
    label,
    failed: failedText,
    text: failedText ? `${label} ${failedText}` : label,
    passedShare: share(passed),
    failedShare: share(failed),
    sendingShare: running ? share(sending) : 0,
    compact: {
      label: running ? `▶ ${finished}` : stopped ? `■ ${finished}` : `✓ ${passed}`,
      failed: !running && failed ? `✕ ${failed}` : "",
    },
  };
}
