// Find usages results as the sidebar lists them.
import { requestFolder } from "./envFolders";
import { basename } from "./http";
import type { Usage, UsageField } from "./types";

/** A line of the Find usages list: one field holding the reference (however many times). */
export interface UsageRow {
  key: string;
  /** The request's name, `@name` for a File variable at the top of a file, or the environment variable's name. */
  title: string;
  /** The request's method (requests only). */
  method?: string;
  /** Where: file and field, or the environment. */
  where: string;
  /** Not sent: a disabled param, header, auth, body or form field. */
  disabled: boolean;
  /** The first reference in the field; opening it opens the field. */
  usage: Usage;
}

const AUTH = { username: "username", password: "password", token: "token", keyValue: "API key value" };

function fieldLabel(f: UsageField): string {
  switch (f.kind) {
    case "url":
      return "URL";
    case "param":
      return `Param ${f.name}`;
    case "header":
      return `Header ${f.name}`;
    case "auth":
      return `Auth ${AUTH[f.part]}`;
    case "body":
      return "Body";
    case "variable":
      return `File variable @${f.name}`;
  }
}

/** The usages as list rows, in the order found, one per field. An environment value in a
 *  folder below workspace `root` names that folder (`api/`). */
export function usageRows(usages: Usage[], root = ""): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const u of usages) {
    let row: Omit<UsageRow, "usage">;
    if (u.kind === "request") {
      // A body can hold both: a disabled form field next to a sent one.
      const key = `${u.path}\0${u.index}\0${JSON.stringify(u.field)}\0${u.disabled}`;
      row = { key, title: u.name, method: u.method, where: `${basename(u.path)} · ${fieldLabel(u.field)}`, disabled: u.disabled };
    } else if (u.kind === "fileVariable") {
      row = { key: `${u.path}\0@${u.index}`, title: `@${u.name}`, where: `${basename(u.path)} · File variable`, disabled: false };
    } else {
      const dir = root ? requestFolder(root, u.path) : "";
      const where = [u.env === "$shared" ? "Shared variables" : `Environment "${u.env}"`, ...(dir ? [`${dir}/`] : []), ...(u.secret ? ["Secret"] : [])];
      row = { key: `${dir}\0${u.env}\0${u.name}`, title: u.name, where: where.join(" · "), disabled: false };
    }
    if (!rows.has(row.key)) rows.set(row.key, { ...row, usage: u });
  }
  return [...rows.values()];
}
