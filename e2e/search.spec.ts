import { expect, test } from "@playwright/test";
import { activeTab, openApp, searchBox, searchResults } from "./helpers";

test("Up/Down move the search selection and Enter opens the selected request", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("pet");

  const results = searchResults(page);
  await expect(results).toHaveText([/List pets/, /Create pet/, /Get pet image/]);
  await expect(results.nth(0)).toHaveAttribute("aria-selected", "true");

  await searchBox(page).press("ArrowDown");
  await searchBox(page).press("ArrowDown");
  await expect(results.nth(2)).toHaveAttribute("aria-selected", "true");
  await searchBox(page).press("ArrowDown"); // stays on the last result
  await expect(results.nth(2)).toHaveAttribute("aria-selected", "true");
  await searchBox(page).press("ArrowUp");
  await expect(results.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(results.nth(0)).toHaveAttribute("aria-selected", "false");

  await searchBox(page).press("Enter");
  await expect(activeTab(page)).toContainText("Create pet");
});
