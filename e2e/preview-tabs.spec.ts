import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTab, openApp, tab, treeItem, urlBar } from "./helpers";

// The Preview tab (GLOSSARY): a navigation opens it, the next one replaces it in
// place, and a change made in it, a Send from it or a double-click in the tree keeps
// it. These single-click on purpose: the shared `openRequest` helper double-clicks.

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");
const italic = (t: Locator) => t.locator(".name").evaluate((el) => getComputedStyle(el).fontStyle === "italic");

/** Expands api/pets.http in the tree. */
async function expandPets(page: Page) {
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
}

test("a single click in the tree opens an italic Preview tab, and the next click replaces it in place", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").dblclick();

  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(activeTab(page)).toContainText("Create pet");
  expect(await italic(tab(page, "Create pet"))).toBe(true);
  expect(await italic(tab(page, "List pets"))).toBe(false);

  // Back to the kept tab, then on to another request: the Preview tab is replaced where it sat.
  await tab(page, "List pets").click();
  await treeItem(page, "Get pet image").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toContainText("Get pet image");
  await expect(tab(page, "Create pet")).toHaveCount(0);
  expect(await italic(tab(page, "Get pet image"))).toBe(true);

  // Enter on a row navigates the same way.
  await treeItem(page, "Create pet").focus();
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toContainText("Create pet");
});

test("a double-click in the tree gives exactly one kept tab", async ({ page }) => {
  await openApp(page);
  await expandPets(page);

  await treeItem(page, "List pets").dblclick();
  await expect(tabs(page)).toHaveCount(1);
  expect(await italic(tab(page, "List pets"))).toBe(false);

  // Kept: the next navigation opens a Preview tab beside it.
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "Create pet"))).toBe(true);
});

test("looking around the Preview tab leaves it a Preview tab; a change made in it keeps it", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").click();
  await expect(urlBar(page)).toBeVisible();

  for (const section of ["Headers", "Authorization", "Body", "Settings", "Params"]) {
    await page.locator(".subtab", { hasText: section }).click();
  }
  expect(await italic(tab(page, "List pets"))).toBe(true);

  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=2");
  await expect.poll(() => italic(tab(page, "List pets"))).toBe(false);

  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
});

test("a Send from the Preview tab keeps it", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").click();
  await expect(urlBar(page)).toBeVisible();

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => italic(tab(page, "List pets"))).toBe(false);
});
