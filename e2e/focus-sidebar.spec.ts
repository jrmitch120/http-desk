// Focus Explorer (⌘⇧E) and Focus History (⌘⇧H), #196: each shows the sidebar if it's
// hidden, switches it to that view and puts focus on the list's current row: the one
// last focused, else the open request's row (Explorer) or the first entry (History),
// else the list itself while it's empty. Ctrl+Shift off macOS.
import { expect, test, type Page } from "@playwright/test";
import { hasRing, menuClick, menuItem, openApp, openRequest, searchBox, searchResults, seedHistory, treeItem, urlBar } from "./helpers";

const aside = (page: Page) => page.locator("aside");
const sidebarView = (page: Page, name: "Explorer" | "History") => page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name });
const historyRegion = (page: Page) => page.getByRole("region", { name: "Workspace History" });
const historyEntries = (page: Page) => historyRegion(page).getByRole("list", { name: "History entries" }).getByRole("listitem");

/** Seeds `/pets/1` … `/pets/n`, a minute apart: `/pets/n` is the newest, listed first. */
function seedPets(page: Page, n: number) {
  const at = (i: number) => new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString();
  return seedHistory(page, Array.from({ length: n }, (_, i) => ({ url: `https://api.test/pets/${i + 1}`, time: at(i + 1) })));
}

test("⌘⇧E from the editor shows a hidden sidebar on the Explorer and focuses the open request's row", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+B");
  await expect(aside(page)).toBeHidden();
  await urlBar(page).click();

  await page.keyboard.press("Meta+Shift+E");

  await expect(aside(page)).toBeVisible();
  await expect(treeItem(page, "List pets")).toBeFocused();
  // Ringed: a key press, after the click into the editor.
  await expect.poll(() => hasRing(treeItem(page, "List pets"))).toBe(true);
  // The tree's keys go on from there.
  await page.keyboard.press("ArrowUp");
  await expect(treeItem(page, "pets.http")).toBeFocused();
});

test("⌘⇧E with a search typed focuses the search box, which the results follow", async ({ page }) => {
  await openApp(page);
  await searchBox(page).fill("pets");
  await expect(searchResults(page).first()).toBeVisible();
  await page.getByRole("button", { name: "New request", exact: true }).focus();

  await page.keyboard.press("Meta+Shift+E");

  await expect(searchBox(page)).toBeFocused();
});

test("⌘⇧E with Find usages showing focuses the usages", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".url-input .cm-var", { hasText: "{{baseUrl}}" }).first().hover();
  await page.locator(".popup-layer .var-card").getByRole("button", { name: "Find usages" }).click();
  const usages = page.getByRole("list", { name: "Usages" }).getByRole("listitem");
  await expect(usages.first()).toBeVisible();
  await urlBar(page).click();

  await page.keyboard.press("Meta+Shift+E");

  await expect(usages.first()).toBeFocused();
});

test("⌘⇧E from the History view switches to the Explorer, on the row last focused there", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "List pets").focus();
  await page.keyboard.press("ArrowUp");
  await expect(treeItem(page, "pets.http")).toBeFocused();
  await sidebarView(page, "History").click();
  await expect(historyRegion(page)).toBeVisible();

  await page.keyboard.press("Meta+Shift+E");

  await expect(sidebarView(page, "Explorer")).toHaveAttribute("aria-checked", "true");
  await expect(treeItem(page, "pets.http")).toBeFocused();
});

test("⌘⇧H from the editor shows a hidden sidebar on History and focuses the newest entry", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+B");
  await expect(aside(page)).toBeHidden();
  await urlBar(page).click();

  await page.keyboard.press("Meta+Shift+H");

  await expect(aside(page)).toBeVisible();
  await expect(sidebarView(page, "History")).toHaveAttribute("aria-checked", "true");
  await expect(historyEntries(page).nth(0)).toBeFocused();
});

test("⌘⇧H from the Explorer switches to History, on the entry last focused there", async ({ page }) => {
  await seedPets(page, 3);
  await openApp(page);
  await sidebarView(page, "History").click();
  await historyEntries(page).nth(0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(historyEntries(page).nth(1)).toBeFocused();
  await sidebarView(page, "Explorer").click();
  await treeItem(page, "api").focus();

  await page.keyboard.press("Meta+Shift+H");

  await expect(sidebarView(page, "History")).toHaveAttribute("aria-checked", "true");
  await expect(historyEntries(page).nth(1)).toBeFocused();
  await expect(historyEntries(page).nth(1)).toContainText("/pets/2");
});

test("⌘⇧H on an empty History focuses what says it's empty", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").focus();

  await page.keyboard.press("Meta+Shift+H");

  await expect(historyRegion(page).getByText("No History in this workspace yet")).toBeFocused();
});

test("Ctrl+Shift+E and Ctrl+Shift+H off macOS", async ({ page }) => {
  await seedPets(page, 2);
  await openApp(page, "?platform=windows");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();

  await page.keyboard.press("Control+Shift+H");
  await expect(historyEntries(page).nth(0)).toBeFocused();

  await page.keyboard.press("Control+Shift+E");
  await expect(treeItem(page, "List pets")).toBeFocused();
});

test("both are in the View menu with their shortcuts, and run from it", async ({ page }) => {
  await seedPets(page, 2);
  await openApp(page);
  expect(await menuItem(page, "focus-explorer")).toMatchObject({ label: "Focus Explorer", accelerator: "Cmd+Shift+E", enabled: true });
  expect(await menuItem(page, "focus-history")).toMatchObject({ label: "Focus History", accelerator: "Cmd+Shift+H", enabled: true });

  await menuClick(page, "focus-history");
  await expect(historyEntries(page).nth(0)).toBeFocused();
  await menuClick(page, "focus-explorer");
  await expect(treeItem(page, "api")).toBeFocused();
});

test("on Windows the menu shows their shortcuts in the labels", async ({ page }) => {
  await openApp(page, "?platform=windows");
  expect(await menuItem(page, "focus-explorer")).toMatchObject({ label: "Focus Explorer\tCtrl+Shift+E", accelerator: null });
  expect(await menuItem(page, "focus-history")).toMatchObject({ label: "Focus History\tCtrl+Shift+H", accelerator: null });
});

for (const { os, explorer, history } of [
  { os: "mac", explorer: "Explorer (⇧⌘E)", history: "History (⇧⌘H)" },
  { os: "windows", explorer: "Explorer (Ctrl+Shift+E)", history: "History (Ctrl+Shift+H)" },
]) {
  test(`on ${os}, the sidebar's Explorer and History switches hint their shortcuts`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    const tip = page.getByRole("tooltip");
    await sidebarView(page, "Explorer").hover();
    await expect(tip).toHaveText(explorer);
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();
    await sidebarView(page, "History").hover();
    await expect(tip).toHaveText(history);
  });
}
