// Every control shows the same focus ring (the shared --focus-ring token).
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

type Outline = { style: string; width: string; color: string; offset: string };

/**
 * Presses Tab until an element matching `selector` has focus, then returns its
 * outline, or the outline of its descendant `part` (a Checkbox draws its ring
 * on the box, a Toggle on the track).
 */
async function tabTo(page: Page, selector: string, part?: string): Promise<Outline> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(
      ([sel, part]) => {
        const el = document.activeElement;
        if (!el?.matches(sel)) return null;
        const s = getComputedStyle(part ? el.querySelector(part)! : el);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
      },
      [selector, part] as const,
    );
    if (outline) return outline;
  }
  throw new Error(`Tab never reached ${selector}`);
}

const ring: Outline = { style: "solid", width: "2px", color: "rgb(91, 157, 255)", offset: "-1px" };

test("buttons, icon buttons and inputs share one focus ring", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Settings" }).click();

  expect(await tabTo(page, ".btn")).toEqual(ring);
  expect(await tabTo(page, ".icon-btn")).toEqual(ring);
  expect(await tabTo(page, ".input")).toEqual(ring);
});

test("owned controls use the same focus ring", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator("body").click({ position: { x: 1, y: 1 } });

  // In document order: sidebar separator, tabs, method Select, the Params
  // section's Toggle, a row Checkbox, the request/response separator.
  expect(await tabTo(page, '[role="separator"]')).toEqual(ring);
  // The tab strip scrolls, so it clips: tabs inset the ring to keep all of it.
  expect(await tabTo(page, '[role="tab"]')).toEqual({ ...ring, offset: "-2px" });
  expect(await tabTo(page, 'button[role="combobox"]')).toEqual(ring);
  expect(await tabTo(page, '[role="switch"]', ".track")).toEqual(ring);
  expect(await tabTo(page, '[role="checkbox"]', ".box")).toEqual(ring);
  expect(await tabTo(page, ".kv input.cell")).toEqual(ring);
  expect(await tabTo(page, '[role="separator"]')).toEqual(ring);

  await page.locator(".subtab", { hasText: "Body" }).click();
  expect(await tabTo(page, '[role="radio"]')).toEqual(ring);
});

test("a grid's text cell shows the ring when clicked, as text fields do", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const cell = page.locator(".kv input.cell").first();
  await cell.click();
  const outline = await cell.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
  });
  expect(outline).toEqual(ring);
});

test("the active tab's accent bar sits inside its focus ring instead of covering it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await tabTo(page, '[role="tab"][aria-selected="true"]');
  // The bar is absolutely positioned, so it paints over the tab's own outline
  // unless it moves in by the ring's width.
  const bar = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement!, "::before");
    return { top: s.top, left: s.left, right: s.right };
  });
  expect(bar).toEqual({ top: "2px", left: "2px", right: "2px" });
});

test("a grid row's delete button shows while it has keyboard focus", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const del = page.locator(".kv-row").first().getByRole("button", { name: "Delete" });
  await page.keyboard.press("Shift");
  await del.focus();
  await expect(del).toHaveCSS("opacity", "1");
  expect(await tabTo(page, ".kv .c-del .icon-btn")).toEqual(ring);
  await expect(page.locator(":focus")).toHaveCSS("opacity", "1");
});
