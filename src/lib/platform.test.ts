import { describe, expect, it } from "vitest";
import { detectOS, formatShortcut, matchesShortcut, wording, type KeyPress } from "./platform";

describe("detectOS", () => {
  it("reads the OS from the webview's navigator.platform", () => {
    expect(detectOS("MacIntel")).toBe("mac"); // WKWebView, on Intel and Apple silicon alike
    expect(detectOS("Win32")).toBe("windows"); // WebView2, 64-bit included
    expect(detectOS("Linux x86_64")).toBe("linux"); // WebKitGTK
    expect(detectOS("Linux aarch64")).toBe("linux");
    expect(detectOS("")).toBe("linux");
  });
});

/** A keydown as the browser reports it: no modifiers unless given. */
function press(key: string, mods: Partial<KeyPress> = {}): KeyPress {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("matchesShortcut on macOS", () => {
  const save = { mod: true, key: "s" };

  it("Mod is ⌘, and Ctrl must not be held", () => {
    expect(matchesShortcut(press("s", { metaKey: true }), save, "mac")).toBe(true);
    expect(matchesShortcut(press("s", { ctrlKey: true }), save, "mac")).toBe(false);
    expect(matchesShortcut(press("s", { metaKey: true, ctrlKey: true }), save, "mac")).toBe(false);
    expect(matchesShortcut(press("s"), save, "mac")).toBe(false);
  });

  it("Shift and Alt must be held exactly when the shortcut asks for them", () => {
    expect(matchesShortcut(press("S", { metaKey: true, shiftKey: true }), save, "mac")).toBe(false);
    expect(matchesShortcut(press("S", { metaKey: true, shiftKey: true }), { ...save, shift: true }, "mac")).toBe(true);
    expect(matchesShortcut(press("s", { metaKey: true }), { ...save, shift: true }, "mac")).toBe(false);
    expect(matchesShortcut(press("w", { metaKey: true, altKey: true }), { mod: true, key: "w" }, "mac")).toBe(false);
  });

  it("matches named keys and characters", () => {
    expect(matchesShortcut(press("Enter", { metaKey: true }), { mod: true, key: "Enter" }, "mac")).toBe(true);
    expect(matchesShortcut(press(",", { metaKey: true, code: "Comma" }), { mod: true, key: "," }, "mac")).toBe(true);
  });

  it("⌥E is a dead key, so ⌘⌥E matches on the physical E key (#78)", () => {
    const pick = { mod: true, alt: true, key: "e" };
    expect(matchesShortcut(press("e", { metaKey: true, altKey: true }), pick, "mac")).toBe(true);
    expect(matchesShortcut(press("Dead", { metaKey: true, altKey: true, code: "KeyE" }), pick, "mac")).toBe(true);
    expect(matchesShortcut(press("´", { metaKey: true, altKey: true, code: "KeyE" }), pick, "mac")).toBe(true);
    expect(matchesShortcut(press("e", { ctrlKey: true, altKey: true }), pick, "mac")).toBe(false);
  });
});

describe.each(["windows", "linux"] as const)("matchesShortcut on %s", (os) => {
  const save = { mod: true, key: "s" };

  it("Mod is Ctrl, and the Windows/Super key must not be held", () => {
    expect(matchesShortcut(press("s", { ctrlKey: true }), save, os)).toBe(true);
    expect(matchesShortcut(press("s", { metaKey: true }), save, os)).toBe(false);
    expect(matchesShortcut(press("s", { metaKey: true, ctrlKey: true }), save, os)).toBe(false);
    expect(matchesShortcut(press("t", { metaKey: true }), { mod: true, key: "t" }, os)).toBe(false);
  });

  it("Shift and Alt must be held exactly when the shortcut asks for them", () => {
    expect(matchesShortcut(press("S", { ctrlKey: true, shiftKey: true }), { ...save, shift: true }, os)).toBe(true);
    expect(matchesShortcut(press("S", { ctrlKey: true, shiftKey: true }), save, os)).toBe(false);
    expect(matchesShortcut(press("W", { ctrlKey: true, shiftKey: true }), { mod: true, shift: true, key: "w" }, os)).toBe(true);
  });

  it("Ctrl+Alt+E matches only a real \"e\": AltGr+E (reported as Ctrl+Alt) types € (#78)", () => {
    const pick = { mod: true, alt: true, key: "e" };
    expect(matchesShortcut(press("e", { ctrlKey: true, altKey: true }), pick, os)).toBe(true);
    expect(matchesShortcut(press("€", { ctrlKey: true, altKey: true, code: "KeyE" }), pick, os)).toBe(false);
    expect(matchesShortcut(press("e", { metaKey: true, altKey: true }), pick, os)).toBe(false);
  });

  it("a shortcut without Mod matches only without Ctrl", () => {
    expect(matchesShortcut(press("F4", { altKey: true }), { alt: true, key: "F4" }, os)).toBe(true);
    expect(matchesShortcut(press("F4", { altKey: true, ctrlKey: true }), { alt: true, key: "F4" }, os)).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("on macOS: glyphs in the order ⌃⌥⇧⌘, then the key, no separators", () => {
    expect(formatShortcut({ mod: true, key: "s" }, "mac")).toBe("⌘S");
    expect(formatShortcut({ mod: true, shift: true, key: "s" }, "mac")).toBe("⇧⌘S");
    expect(formatShortcut({ mod: true, alt: true, key: "e" }, "mac")).toBe("⌥⌘E");
    expect(formatShortcut({ mod: true, alt: true, shift: true, key: "w" }, "mac")).toBe("⌥⇧⌘W");
    expect(formatShortcut({ mod: true, key: "Enter" }, "mac")).toBe("⌘↩");
    expect(formatShortcut({ mod: true, key: "," }, "mac")).toBe("⌘,");
  });

  it.each(["windows", "linux"] as const)("on %s: Ctrl+Alt+Shift+Key text", (os) => {
    expect(formatShortcut({ mod: true, key: "s" }, os)).toBe("Ctrl+S");
    expect(formatShortcut({ mod: true, shift: true, key: "s" }, os)).toBe("Ctrl+Shift+S");
    expect(formatShortcut({ mod: true, alt: true, key: "e" }, os)).toBe("Ctrl+Alt+E");
    expect(formatShortcut({ mod: true, alt: true, shift: true, key: "w" }, os)).toBe("Ctrl+Alt+Shift+W");
    expect(formatShortcut({ mod: true, key: "Enter" }, os)).toBe("Ctrl+Enter");
    expect(formatShortcut({ mod: true, key: "," }, os)).toBe("Ctrl+,");
    expect(formatShortcut({ alt: true, key: "F4" }, os)).toBe("Alt+F4");
  });
});

describe("wording", () => {
  it("on macOS: Finder and the Trash", () => {
    const w = wording("mac");
    expect(w.reveal).toBe("Reveal in Finder");
    expect(w.moveToTrash).toBe("Move to Trash");
    expect(w.trashQuestion("x.http")).toBe('Move "x.http" to the Trash?');
    expect(w.trashUnavailable).toBe("Couldn't Move to the Trash");
  });

  it("on Windows: File Explorer and the Recycle Bin", () => {
    const w = wording("windows");
    expect(w.reveal).toBe("Show in File Explorer");
    expect(w.moveToTrash).toBe("Delete");
    expect(w.trashQuestion("x.http")).toBe('Move "x.http" to the Recycle Bin?');
    expect(w.trashUnavailable).toBe("Couldn't Move to the Recycle Bin");
  });

  it("on Linux: the containing folder and the Trash", () => {
    const w = wording("linux");
    expect(w.reveal).toBe("Open Containing Folder");
    expect(w.moveToTrash).toBe("Move to Trash");
    expect(w.trashQuestion("x.http")).toBe('Move "x.http" to the Trash?');
    expect(w.trashUnavailable).toBe("Couldn't Move to the Trash");
  });
});
