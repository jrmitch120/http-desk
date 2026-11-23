// #195: a panel's command puts focus in its list. ⌘J (Session), ⌘⇧M (Problems) and
// Show Runner (the menu) show the panel and focus its list; with the panel showing
// and focus elsewhere they focus the list; with focus in the panel they hide it, and
// focus goes back to the active tab. `?chain=1` names Create pet `createPet`, so a
// send of it puts a row in the Session's Named exchanges. `?problems=1` adds two
// files with problems.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, menuClick, openApp, openRequest, sentRequests, treeMenu, urlBar } from "./helpers";

const region = (page: Page, name: string) => page.getByRole("region", { name });
const rows = (page: Page, name: string) => region(page, name).getByRole("listitem");

/** Sends Create pet from its tab, putting `createPet` in the Session's Named exchanges. */
async function sendCreatePet(page: Page) {
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(1);
}

test("from the editor, ⌘J shows the Session panel with focus on its first row; ⌘J from there hides it and focus returns to the tab", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await urlBar(page).click();

  await page.keyboard.press("Meta+j");

  await expect(rows(page, "Session").first()).toBeFocused();
  await expect(rows(page, "Session").first()).toContainText("createPet");

  await page.keyboard.press("Meta+j");

  await expect(region(page, "Session")).toBeHidden();
  await expect(activeTab(page)).toBeFocused();
});

test("with the Session panel showing and focus elsewhere, ⌘J focuses its list instead of hiding it", async ({ page }) => {
  await openApp(page, "?chain=1");
  await sendCreatePet(page);
  await page.keyboard.press("Meta+j");
  await expect(rows(page, "Session").first()).toBeFocused();
  await urlBar(page).click();

  await page.keyboard.press("Meta+j");

  await expect(region(page, "Session")).toBeVisible();
  await expect(rows(page, "Session").first()).toBeFocused();
});

test("⌘⇧M shows the Problems panel with focus on its first problem, focuses it again from elsewhere, and hides it from inside", async ({ page }) => {
  await openApp(page, "?problems=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();

  await page.keyboard.press("Meta+Shift+m");

  await expect(rows(page, "Problems").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows(page, "Problems").nth(1)).toBeFocused();

  await urlBar(page).click();
  await page.keyboard.press("Meta+Shift+m");
  // The row it was on.
  await expect(rows(page, "Problems").nth(1)).toBeFocused();

  await page.keyboard.press("Meta+Shift+m");

  await expect(region(page, "Problems")).toBeHidden();
  await expect(activeTab(page)).toBeFocused();
});

test("with nothing to list, ⌘⇧M still puts focus in the Problems panel, so pressing it again hides it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();

  await page.keyboard.press("Meta+Shift+m");

  await expect(region(page, "Problems")).toBeFocused();
  await page.keyboard.press("Meta+Shift+m");
  await expect(region(page, "Problems")).toBeHidden();
  await expect(activeTab(page)).toBeFocused();
});

test("Show Runner from the menu focuses the Runner's results, at the result shown, and hides the panel from inside", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeMenu(page, "pets.http", "Run file");
  await expect(region(page, "Runner")).toContainText("3 passed");
  await rows(page, "Runner").first().click();
  // Focus is in the panel: Show Runner hides it.
  await menuClick(page, "toggle-runner");
  await expect(region(page, "Runner")).toBeHidden();

  // Hidden: shown, with focus on its first result.
  await menuClick(page, "toggle-runner");
  await expect(rows(page, "Runner").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(rows(page, "Runner").nth(1)).toHaveAttribute("aria-current", "true");

  // Showing, focus elsewhere: focused, at the result shown.
  await urlBar(page).click();
  await menuClick(page, "toggle-runner");
  await expect(rows(page, "Runner").nth(1)).toBeFocused();

  await menuClick(page, "toggle-runner");
  await expect(region(page, "Runner")).toBeHidden();
  await expect(activeTab(page)).toBeFocused();
});
