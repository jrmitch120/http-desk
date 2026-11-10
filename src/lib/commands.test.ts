// The command registry: which command a key press is the shortcut of on each
// OS, and when a command can run (ADR-0005, #15/#74).
import { afterEach, describe, expect, it } from "vitest";
import { canRun, commandForKey } from "./commands";
import { trackModal } from "./modal.svelte";
import { forceOS, type KeyPress, type OS } from "./platform";

/** A keydown as the browser reports it: no modifiers unless given. */
function press(key: string, mods: Partial<KeyPress> = {}): KeyPress {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

/** The id of the command `e` runs on `os`, if any. */
function on(os: OS, e: KeyPress): string | undefined {
  forceOS(os);
  return commandForKey(e)?.id;
}

afterEach(() => forceOS(null));

describe("commandForKey", () => {
  it("finds a command by its shortcut, with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(on("mac", press("s", { metaKey: true }))).toBe("save");
    expect(on("mac", press("S", { metaKey: true, shiftKey: true }))).toBe("save-all");
    expect(on("mac", press("w", { metaKey: true }))).toBe("close-tab");
    expect(on("mac", press("W", { metaKey: true, shiftKey: true }))).toBe("close-window");
    expect(on("mac", press("Enter", { metaKey: true }))).toBe("send");
    expect(on("windows", press("s", { ctrlKey: true }))).toBe("save");
    expect(on("linux", press(",", { ctrlKey: true }))).toBe("settings");
  });

  it("leaves the other OS's modifier alone: Ctrl+S on macOS, the Windows key elsewhere", () => {
    expect(on("mac", press("s", { ctrlKey: true }))).toBeUndefined();
    expect(on("mac", press("t", { ctrlKey: true }))).toBeUndefined();
    expect(on("windows", press("s", { metaKey: true }))).toBeUndefined();
    expect(on("linux", press("s", { metaKey: true }))).toBeUndefined();
  });

  it("tells shortcuts apart by Alt and Shift", () => {
    expect(on("mac", press("e", { metaKey: true }))).toBe("manage-environments");
    expect(on("mac", press("´", { code: "KeyE", metaKey: true, altKey: true }))).toBe("choose-environment");
    expect(on("windows", press("e", { ctrlKey: true, altKey: true }))).toBe("choose-environment");
    expect(on("mac", press("s"))).toBeUndefined();
  });

  it("toggles the sidebar with ⌘B on macOS and Ctrl+B elsewhere", () => {
    expect(on("mac", press("b", { metaKey: true }))).toBe("toggle-sidebar");
    expect(on("windows", press("b", { ctrlKey: true }))).toBe("toggle-sidebar");
    expect(on("linux", press("b", { ctrlKey: true }))).toBe("toggle-sidebar");
    expect(on("mac", press("b", { ctrlKey: true }))).toBeUndefined();
  });

  it("runs a command from its unshown aliases too", () => {
    expect(on("mac", press("p", { metaKey: true }))).toBe("search");
    expect(on("mac", press("k", { metaKey: true }))).toBe("search");
  });

  it("takes a command's keys only on the OSes it names: Ctrl+Q quits on Linux only", () => {
    expect(on("linux", press("q", { ctrlKey: true }))).toBe("quit");
    expect(on("windows", press("q", { ctrlKey: true }))).toBeUndefined();
    expect(on("mac", press("q", { metaKey: true }))).toBeUndefined();
  });

  it("finds nothing for the Edit items, whose keys stay the text field's", () => {
    expect(on("linux", press("c", { ctrlKey: true }))).toBeUndefined();
    expect(on("linux", press("v", { ctrlKey: true }))).toBeUndefined();
    expect(on("linux", press("z", { ctrlKey: true }))).toBeUndefined();
  });
});

describe("canRun", () => {
  it("is a command's own rule while no modal is open", () => {
    expect(canRun("settings")).toBe(true);
    expect(canRun("about")).toBe(true);
    // No workspace and no tab in a fresh store.
    expect(canRun("new-request")).toBe(false);
    expect(canRun("close-tab")).toBe(false);
    expect(canRun("send")).toBe(false);
  });

  it("is false for app commands while a modal or dialog is open, except those that run under one", () => {
    const closed = trackModal();
    try {
      expect(canRun("settings")).toBe(false);
      expect(canRun("about")).toBe(false);
      expect(canRun("quit")).toBe(true);
    } finally {
      closed();
    }
    expect(canRun("settings")).toBe(true);
  });
});
