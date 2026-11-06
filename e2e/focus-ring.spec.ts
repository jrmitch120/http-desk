// Every control shows the same focus ring (the shared --focus-ring token).
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

/** Presses Tab until an element matching `selector` has focus, then returns its outline. */
async function tabTo(page: Page, selector: string): Promise<{ style: string; width: string; color: string }> {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const outline = await page.evaluate((sel) => {
      const el = document.activeElement;
      if (!el?.matches(sel)) return null;
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
    }, selector);
    if (outline) return outline;
  }
  throw new Error(`Tab never reached ${selector}`);
}

test("buttons, icon buttons and inputs share one focus ring", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Settings" }).click();

  const ring = { style: "solid", width: "2px", color: "rgb(91, 157, 255)" };
  expect(await tabTo(page, ".btn")).toEqual(ring);
  expect(await tabTo(page, ".icon-btn")).toEqual(ring);
  expect(await tabTo(page, ".input")).toEqual(ring);
});
