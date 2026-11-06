// use:tooltip links its text as the element's description when the text
// differs from the element's accessible name.
import { afterEach, describe, expect, it } from "vitest";
import { hideTooltip, tooltip, TOOLTIP_ID } from "./tooltip.svelte";

/** The parts of an element the action touches. */
function element(attrs: Record<string, string>) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const values = new Map(Object.entries(attrs));
  const el = {
    getAttribute: (name: string) => values.get(name) ?? null,
    setAttribute: (name: string, value: string) => values.set(name, value),
    removeAttribute: (name: string) => values.delete(name),
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    removeEventListener: () => {},
    matches: () => false,
  };
  const hover = () => listeners.pointerenter({ pointerType: "mouse" });
  return { node: el as unknown as HTMLElement, hover };
}

afterEach(() => hideTooltip(false));

describe("use:tooltip", () => {
  it("describes the element only while its text differs from the aria-label, also when the text changes", () => {
    const { node, hover } = element({ "aria-label": "Secret" });
    const action = tooltip(node, "Secret");
    hover();
    expect(node.getAttribute("aria-describedby")).toBeNull();

    action.update("Secret: saved only in the private file.");
    expect(node.getAttribute("aria-describedby")).toBe(TOOLTIP_ID);

    action.update("Secret");
    expect(node.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps the element's own descriptions", () => {
    const { node, hover } = element({ "aria-label": "Secret", "aria-describedby": "hint" });
    const action = tooltip(node, "Secret");
    hover();
    action.update("Saved only in the private file.");
    expect(node.getAttribute("aria-describedby")).toBe(`hint ${TOOLTIP_ID}`);
    action.update("Secret");
    expect(node.getAttribute("aria-describedby")).toBe("hint");
  });
});
