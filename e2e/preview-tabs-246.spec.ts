import { expect, test, type Locator, type Page } from "@playwright/test";
import { menuClick, menuItem, openApp, tab, treeItem } from "./helpers";

// Keeping the Preview tab (GLOSSARY) without changing it or sending from it: a
// double-click on the tab, Keep open in its context menu, or File → Keep Open. These
// single-click in the tree on purpose: the shared `openRequest` helper double-clicks.

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");
const italic = (t: Locator) => t.locator(".name").evaluate((el) => getComputedStyle(el).fontStyle === "italic");

/** Expands api/pets.http in the tree. */
async function expandPets(page: Page) {
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
}

test("a double-click on the Preview tab keeps it; on a kept tab it does nothing", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").click();
  expect(await italic(tab(page, "List pets"))).toBe(true);

  await tab(page, "List pets").dblclick();
  await expect.poll(() => italic(tab(page, "List pets"))).toBe(false);

  // Kept: the next navigation opens a Preview tab beside it.
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "Create pet"))).toBe(true);

  // A double-click on the kept tab leaves both tabs as they were.
  await tab(page, "List pets").dblclick();
  await expect(tabs(page)).toHaveCount(2);
  expect(await italic(tab(page, "List pets"))).toBe(false);
  expect(await italic(tab(page, "Create pet"))).toBe(true);
});

test("Keep open in the tab's context menu is enabled only for the Preview tab, and keeps it", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").dblclick();
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);

  const keepOpen = page.getByRole("menuitem", { name: "Keep open" });
  await tab(page, "List pets").click({ button: "right" });
  await expect(keepOpen).toBeDisabled();
  await page.keyboard.press("Escape");

  await tab(page, "Create pet").click({ button: "right" });
  await expect(keepOpen).toBeEnabled();
  await keepOpen.click();
  await expect.poll(() => italic(tab(page, "Create pet"))).toBe(false);

  await treeItem(page, "Get pet image").click();
  await expect(tabs(page)).toHaveCount(3);
  expect(await italic(tab(page, "Get pet image"))).toBe(true);
});

test("File → Keep Open keeps the active Preview tab, and is greyed out on a kept tab", async ({ page }) => {
  await openApp(page);
  await expandPets(page);
  await treeItem(page, "List pets").click();
  await expect.poll(() => menuItem(page, "keep-tab")).toMatchObject({ label: "Keep Open", enabled: true });

  await menuClick(page, "keep-tab");

  await expect.poll(() => italic(tab(page, "List pets"))).toBe(false);
  await expect.poll(() => menuItem(page, "keep-tab")).toMatchObject({ enabled: false });
  await treeItem(page, "Create pet").click();
  await expect(tabs(page)).toHaveCount(2);
});
