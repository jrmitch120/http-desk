// Messages the core writes, as the dev mock (mock.ts) repeats them so the app reads
// the same under Vite as in the shell. coreMessages.test.ts checks each against the
// Rust that writes it, so a change there fails until the copy here follows.

/** `ExecError::UntrustedWorkspace` (exec.rs). */
export const UNTRUSTED_MESSAGE = "This request has a script, and this workspace isn't trusted to run scripts. Trust it, or send without scripts.";

/** `ExecError::UnsentRequest`'s message naming `names` (exec.rs `unsent_text`). */
export function unsentMessage(names: string[]): string {
  const quoted = names.map((n) => `\`${n}\``);
  if (quoted.length === 1) return `This request reads the latest exchange of ${quoted[0]}, which hasn't been sent in this Session. Send ${quoted[0]} first.`;
  const last = quoted.pop();
  return `This request reads the latest exchanges of ${quoted.join(", ")} and ${last}, which haven't been sent in this Session. Send them first.`;
}

/** The warning on a send whose scripts were skipped (send.rs `scripts_skipped`): `skipped` names them. */
export const sentWithoutScripts = (skipped: string) => `Sent without scripts: ${skipped} didn't run.`;

/** The note on a `>> path` / `>>! path` (`bang`) redirect (exec.rs `redirect_not_run`). */
export const redirectNotRun = (bang: string, path: string) => `HttpDesk doesn't run response redirects: >>${bang} ${path} doesn't save the response to a file.`;

/** Why the script file `reference` can't run (script.rs `ScriptFiles::locate`). */
export const scriptFileOutside = (reference: string) => `Script file ${reference} is outside the workspace`;
export const scriptFileMissing = (reference: string) => `Script file ${reference} doesn't exist`;

/** The warning on a send whose folder (`folder`: `api/` or "the workspace root") doesn't define `environment` (send.rs `scope`). */
export const environmentMissing = (environment: string, folder: string) =>
  `Environment "${environment}" isn't defined for ${folder}, so it's sent with no environment`;
