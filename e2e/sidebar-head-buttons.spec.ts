// The sidebar header's icon buttons (the Explorer's actions and Collapse sidebar):
// the actions are square, so a hover's background sits evenly around each icon, and
// stay on one row beside the view switch. Every icon sits a whole pixel in from its
// button's edges; half a pixel in, it's drawn a pixel off-centre.
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test("the sidebar header's icons are centred on whole pixels, the Explorer's actions square on one row beside the view switch", async ({ page }) => {
  await openApp(page);
  const buttons = await page.locator(".sidebar .head button.icon-btn").evaluateAll((bs) =>
    bs.map((b) => {
      const r = b.getBoundingClientRect();
      const s = b.querySelector("svg")!.getBoundingClientRect();
      return { label: b.getAttribute("aria-label")!, w: r.width, h: r.height, inset: [s.x - r.x, r.right - s.right, s.y - r.y, r.bottom - s.bottom] };
    }),
  );
  expect(buttons.map((b) => b.label)).toEqual(["New .http file", "New folder", "Import OpenAPI", "Refresh", "Collapse all", "Collapse sidebar"]);
  for (const b of buttons) {
    if (b.label !== "Collapse sidebar") expect(b.w, b.label).toBe(b.h);
    const [l, r, t, btm] = b.inset;
    expect([l, t], b.label).toEqual([r, btm]);
    expect(Number.isInteger(l) && Number.isInteger(t), `${b.label}: icon inset ${l}, ${t}`).toBe(true);
  }
  const top = async (sel: string) => (await page.locator(sel).boundingBox())!.y;
  expect(Math.abs((await top(".sidebar .actions")) - (await top(".sidebar .views")))).toBeLessThan(10);
});
