import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTab, openApp, openRequest, searchBox, searchResults, tab, treeItem } from "./helpers";

// The Preview tab's other entry points (#247): a search hit, "View file as text" and
// the File view's Request button navigate, so they open the Preview tab; a File view
// can be the Preview tab, and typing in it keeps it.

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");
const italic = (t: Locator) => t.locator(".name").evaluate((el) => getComputedStyle(el).fontStyle === "italic");
const fileLine = (page: Page, text: string) => page.locator(".file-view .file-code .cm-line", { hasText: text });

test("a search hit opens the Preview tab, and the next one replaces it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  // Clicked once the results are this search's: they follow the typing after a pause.
  await searchBox(page).fill("create");
  await searchResults(page).filter({ hasText: "Create pet" }).click();
  await expect(activeTab(page)).toContainText("Create pet");
  expect(await italic(tab(page, "Create pet"))).toBe(true);

  await searchBox(page).fill("image");
  await searchResults(page).filter({ hasText: "Get pet image" }).click();
  await expect(activeTab(page)).toContainText("Get pet image");
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "Get pet image"))).toBe(true);
});

test("View file as text opens the File view as the Preview tab; its Request button replaces it, and typing in it keeps it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  await page.getByRole("button", { name: "View file as text" }).click();
  await expect(activeTab(page)).toContainText("pets.http");
  expect(await italic(tab(page, "pets.http"))).toBe(true);

  // Its Request button navigates: the request replaces the File view where it sat.
  await fileLine(page, "### Create pet").click();
  await page.locator(".file-view").getByRole("button", { name: "Request" }).click();
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "Create pet"))).toBe(true);

  // Back to it, then the first text typed keeps it.
  await page.getByRole("button", { name: "View file as text" }).click();
  await expect(tabs(page)).toHaveCount(2);
  await fileLine(page, "### Create pet").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" now");
  await expect.poll(() => italic(tab(page, "pets.http"))).toBe(false);
  await tab(page, "List pets").click();
  await treeItem(page, "Get pet image").click();
  await expect(tabs(page)).toHaveCount(3);
});
