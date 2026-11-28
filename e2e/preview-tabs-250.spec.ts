import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, openApp, tab, treeItem } from "./helpers";

// #250: the Preview tabs app setting (Settings → General), on by default. Turned off, the
// open Preview tab becomes kept and every navigation opens a kept tab. These single-click
// the tree on purpose: the shared `openRequest` helper double-clicks.

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");
const italic = (t: Locator) => t.locator(".name").evaluate((el) => getComputedStyle(el).fontStyle === "italic");
const settings = (page: Page) => dialog(page, "Settings");
const previewSwitch = (page: Page) => settings(page).getByRole("tabpanel", { name: "General" }).getByRole("switch", { name: "Preview tabs" });

async function expandPets(page: Page) {
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
}

test("Preview tabs is on by default in General; turned off, the Preview tab is kept and the next navigation opens another kept tab", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").click();
  expect(await italic(tab(page, "List pets"))).toBe(true);

  await page.keyboard.press("Meta+Comma");
  await expect(previewSwitch(page)).toBeChecked();
  await previewSwitch(page).click();
  await expect(previewSwitch(page)).not.toBeChecked();
  await settings(page).getByRole("button", { name: "Done" }).click();

  expect(await italic(tab(page, "List pets"))).toBe(false);
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "Create pet"))).toBe(false);

  // Back on: only later navigations open a Preview tab.
  await page.keyboard.press("Meta+Comma");
  await previewSwitch(page).click();
  await settings(page).getByRole("button", { name: "Done" }).click();
  expect(await italic(tab(page, "Create pet"))).toBe(false);
  await treeItem(page, "Get pet image").click();
  await expect(tabs(page)).toHaveCount(3);
  expect(await italic(tab(page, "Get pet image"))).toBe(true);
});
