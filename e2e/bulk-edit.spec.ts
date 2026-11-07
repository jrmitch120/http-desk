import { expect, test } from "@playwright/test";
import { openApp, openRequest, treeItem } from "./helpers";

test("bulk-edit text is applied as it's typed, so switching tabs keeps it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.getByRole("button", { name: "Bulk edit" }).click();

  const text = page.locator("textarea.bulk-text");
  await text.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nX-Bulk: yes");
  await expect(page.locator(".tab.active .dot")).toBeVisible();

  // Switch away while still in bulk mode, then come back.
  await treeItem(page, "Create pet").click();
  await page.locator(".tab", { hasText: "List pets" }).click();
  await page.locator(".subtab", { hasText: "Headers" }).click();

  const names = page.locator(".kv-row:not(.ghost) input.c-name");
  await expect(names.last()).toHaveValue("X-Bulk");
  await expect(page.locator(".kv-row:not(.ghost) .c-value").last()).toHaveText("yes");
});
