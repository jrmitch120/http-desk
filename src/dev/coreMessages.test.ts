// The dev mock's copies of the core's messages (coreMessages.ts) match the Rust that
// writes them: every fixed part of each message is in that source.
import { describe, expect, it } from "vitest";
import exec from "../../crates/httpdesk-core/src/exec.rs?raw";
import script from "../../crates/httpdesk-core/src/script.rs?raw";
import send from "../../crates/httpdesk-core/src/send.rs?raw";
import {
  environmentMissing,
  redirectNotRun,
  scriptFileMissing,
  scriptFileOutside,
  sentWithoutScripts,
  UNTRUSTED_MESSAGE,
  unsentMessage,
} from "./coreMessages";

/** A stand-in for each value the core formats into a message. */
const HOLE = "\u0001";

/** The parts of `message` around its holes, each of which must be in `source` (Rust string escapes undone). */
function expectWrittenBy(source: string, message: string) {
  const text = source.replaceAll('\\"', '"');
  for (const part of message.split(HOLE).filter(Boolean)) expect(text, `the core no longer writes "${part}"`).toContain(part);
}

describe("the mock's copies of the core's messages", () => {
  it("are the core's", () => {
    expectWrittenBy(exec, UNTRUSTED_MESSAGE);
    // The core quotes each name itself.
    expectWrittenBy(exec, unsentMessage([HOLE]).replaceAll(`\`${HOLE}\``, HOLE));
    expectWrittenBy(exec, unsentMessage([HOLE, HOLE]).replaceAll(`\`${HOLE}\``, HOLE));
    expectWrittenBy(exec, redirectNotRun(HOLE, HOLE));
    expectWrittenBy(send, sentWithoutScripts(HOLE));
    expectWrittenBy(send, environmentMissing(HOLE, HOLE));
    // The core writes "Script file {reference} {why}", with each reason on its own.
    expectWrittenBy(script, scriptFileOutside(HOLE).replace(`${HOLE} `, HOLE.repeat(2)));
    expectWrittenBy(script, scriptFileMissing(HOLE).replace(`${HOLE} `, HOLE.repeat(2)));
  });
});
