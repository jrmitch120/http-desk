import { EDITORS, EDITOR_NAMES, type EditorName } from "./checks";

/** The bottom bar's Portability label: the editors turned on in Settings → Portability,
 *  in their Settings order ("VS Code · Rider"), or "HttpDesk only" with both off. */
export function portabilityLabel(editors: Record<EditorName, boolean>): string {
  const on = EDITORS.filter((e) => editors[e]).map((e) => EDITOR_NAMES[e]);
  return on.length ? on.join(" · ") : "HttpDesk only";
}
