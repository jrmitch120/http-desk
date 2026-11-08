// The one place that knows which OS the app runs on, and what that means for
// shortcuts, dialog button order and wording. Pure and synchronous: the OS
// comes from the page, before any IPC.

export type OS = "mac" | "windows" | "linux";

const OSES: readonly OS[] = ["mac", "windows", "linux"];

/** The OS a webview's `navigator.platform` names ("MacIntel", "Win32", "Linux x86_64"). */
export function detectOS(navigatorPlatform: string): OS {
  if (/Mac|iPhone|iPad/.test(navigatorPlatform)) return "mac";
  if (/Win/.test(navigatorPlatform)) return "windows";
  return "linux";
}

let forced: OS | null = null;

/** The OS the app runs on. */
export function currentOS(): OS {
  return forced ?? detectOS(globalThis.navigator?.platform ?? "");
}

/**
 * Makes the app behave as if it ran on `os`. For the dev mock's `?platform=`
 * only (src/dev/mock.ts), which runs before the app mounts. Anything that
 * isn't an OS goes back to the detected one.
 */
export function forceOS(os: string | null): void {
  forced = OSES.find((o) => o === os) ?? null;
}

/**
 * A keyboard shortcut. `mod` is the platform's primary modifier: ⌘ on macOS,
 * Ctrl elsewhere. `key` is a `KeyboardEvent.key` value: a letter ("s"), a
 * named key ("Enter", "F4") or a character (",").
 */
export interface Shortcut {
  key: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const MAC_KEYS: Record<string, string> = { Enter: "↩" };

/** How a shortcut reads on `os`: "⇧⌘S" on macOS, "Ctrl+Shift+S" elsewhere. */
export function formatShortcut(s: Shortcut, os: OS = currentOS()): string {
  const key = keyLabel(s.key, os);
  if (os === "mac") return (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.mod ? "⌘" : "") + key;
  return joinShortcut(s, "Ctrl");
}

/**
 * A shortcut as words joined with "+", the primary modifier named `mod`:
 * "Ctrl+Shift+S" for hints off macOS, "Cmd+Shift+S" for the shell's macOS key
 * equivalents (src/lib/menuLayout.ts).
 */
export function joinShortcut(s: Shortcut, mod: string): string {
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [s.mod && mod, s.alt && "Alt", s.shift && "Shift", key].filter(Boolean).join("+");
}

/** The parts of a `KeyboardEvent` a shortcut is matched against. */
export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/**
 * Whether `e` is shortcut `s` on `os`. Mod is ⌘ on macOS and Ctrl elsewhere,
 * and the other one must not be held; Alt and Shift must match exactly.
 */
export function matchesShortcut(e: KeyPress, s: Shortcut, os: OS = currentOS()): boolean {
  const [mod, other] = os === "mac" ? [e.metaKey, e.ctrlKey] : [e.ctrlKey, e.metaKey];
  if (other || mod !== !!s.mod || e.altKey !== !!s.alt || e.shiftKey !== !!s.shift) return false;
  if (e.key.toLowerCase() === s.key.toLowerCase()) return true;
  // ⌥ turns a letter into another character or a dead key on macOS (⌥E is
  // the acute accent), so there the physical key counts.
  return os === "mac" && !!s.alt && /^[a-z]$/i.test(s.key) && e.code === `Key${s.key.toUpperCase()}`;
}

function keyLabel(key: string, os: OS): string {
  if (os === "mac" && MAC_KEYS[key]) return MAC_KEYS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * What a dialog button is for, which decides where it sits:
 * - `primary`: the default answer (Enter, and focus unless another button asks
 *   for it). A destructive confirmation's action ("Move to Trash") is primary too.
 * - `destructive`: an alternative to the primary that throws work away ("Don't save").
 * - `cancel`: the button Escape stands for.
 */
export type ButtonRole = "primary" | "destructive" | "cancel";

/**
 * Where `os` puts a dialog's buttons, each group left to right: `start` at the
 * far left, `end` at the right. macOS (and GTK on Linux) puts the primary
 * rightmost, after Cancel, and a destructive alternative apart at the far left:
 * `[Don't save] … [Cancel] [Save all]`. Windows puts the primary first:
 * `[Save all] [Don't save] [Cancel]`. Buttons without a role keep their order,
 * between the alternatives and Cancel.
 */
export function arrangeDialogButtons<B extends { role?: ButtonRole }>(buttons: B[], os: OS = currentOS()): { start: B[]; end: B[] } {
  const withRole = (role?: ButtonRole) => buttons.filter((b) => b.role === role);
  const [primary, destructive, cancel, other] = [withRole("primary"), withRole("destructive"), withRole("cancel"), withRole(undefined)];
  if (os === "windows") return { start: [], end: [...primary, ...destructive, ...other, ...cancel] };
  return { start: destructive, end: [...other, ...cancel, ...primary] };
}

/** Words that differ by OS: what its file manager and its trash are called. */
export interface Wording {
  /** Context menu item that shows a file or folder in the file manager. */
  reveal: string;
  /** Context menu item, and its confirmation's title and button, for deleting to the trash. */
  moveToTrash: string;
  /** The delete confirmation's question about the file or folder `name`. */
  trashQuestion: (name: string) => string;
  /** Title of the question asked when the trash can't take it (delete permanently instead?). */
  trashUnavailable: string;
}

const WORDING: Record<OS, Wording> = {
  mac: {
    reveal: "Reveal in Finder",
    moveToTrash: "Move to Trash",
    trashQuestion: (name) => `Move "${name}" to the Trash?`,
    trashUnavailable: "Couldn't Move to the Trash",
  },
  windows: {
    reveal: "Show in File Explorer",
    moveToTrash: "Delete",
    trashQuestion: (name) => `Move "${name}" to the Recycle Bin?`,
    trashUnavailable: "Couldn't Move to the Recycle Bin",
  },
  linux: {
    reveal: "Open Containing Folder",
    moveToTrash: "Move to Trash",
    trashQuestion: (name) => `Move "${name}" to the Trash?`,
    trashUnavailable: "Couldn't Move to the Trash",
  },
};

/** The words `os` uses (see `Wording`): `wording().reveal` is "Reveal in Finder" on macOS. */
export function wording(os: OS = currentOS()): Wording {
  return WORDING[os];
}
