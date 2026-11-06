// Status pills, method badges and "OFF" pills are one Badge, so their type,
// corners and paddings match wherever they appear.
import { expect, test, type Locator } from "@playwright/test";
import { openApp, openRequest, treeItem } from "./helpers";

async function shape(badge: Locator) {
  return badge.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      font: { family: s.fontFamily, weight: s.fontWeight, radius: s.borderRadius },
      box: { size: s.fontSize, height: s.height, padding: s.padding },
    };
  });
}

test("status, method and OFF pills share one badge shape", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("switch", { name: "Enabled" }).click();
  await page.keyboard.press("ControlOrMeta+Enter");

  const off = await shape(page.locator(".subtab", { hasText: "Params" }).getByText("OFF", { exact: true }));
  const method = await shape(treeItem(page, "List pets").getByText("GET", { exact: true }));
  const status = await shape(page.getByText("200 OK", { exact: true }));

  expect(method).toEqual(off);
  expect(status.font).toEqual(off.font);
});
