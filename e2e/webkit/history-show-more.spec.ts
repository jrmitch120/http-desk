// The keyboard reaches the whole History in WebKit, the app's webview on macOS and
// Linux (#193). "Show more" lists the next page as it scrolls into view, but WebKit
// scrolls a row focused at the end of the list only as far as the row, leaving
// "Show more" just out of sight; Chromium scrolls further and shows it. So End, or
// Down on the last row, lists more itself (e2e/history-keyboard.spec.ts has the rest).
import { expect, test, type Page } from "@playwright/test";
import { openApp, seedHistory } from "../helpers";

const sidebarHistory = (page: Page) => page.getByRole("region", { name: "Workspace History" });
const entries = (page: Page) => sidebarHistory(page).getByRole("list", { name: "History entries" }).getByRole("listitem");

test("End, or Down on the last row, lists more History entries", async ({ page }) => {
  // 120 entries, a minute apart: /pets/120 is the newest.
  const at = (i: number) => new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString();
  await seedHistory(page, Array.from({ length: 120 }, (_, i) => ({ url: `https://api.test/pets/${i + 1}`, time: at(i + 1) })));
  await openApp(page);
  await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
  await expect(entries(page)).toHaveCount(50);
  await entries(page).nth(0).focus();

  await page.keyboard.press("End");
  await expect(entries(page)).toHaveCount(100);
  await page.keyboard.press("ArrowDown");
  await expect(entries(page).nth(50)).toBeFocused();

  await page.keyboard.press("End");
  await expect(entries(page)).toHaveCount(120);
  await expect(entries(page).nth(99)).toBeFocused();
});
