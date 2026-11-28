// The Layout keeps which tab is the Preview tab (#249): a restart brings it back
// italic, and the next navigation replaces it. The mock keeps Layouts in
// sessionStorage, so a page reload stands in for a restart.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockState, openApp, tab, treeItem } from "./helpers";

const tabNames = (page: Page) => page.getByRole("tablist", { name: "Open requests" }).getByRole("tab").locator(".name");
const italic = (t: Locator) => t.locator(".name").evaluate((el) => getComputedStyle(el).fontStyle === "italic");

/** Which saved tabs, by name, the mock's last Layout for /demo marks as the Preview tab. */
async function savedPreview(page: Page): Promise<[string, boolean][] | null> {
  const layout = (await mockState(page, "layouts"))["/demo"] as { tabs: { name: string; preview?: boolean }[] } | undefined;
  return layout ? layout.tabs.map((t) => [t.name, !!t.preview]) : null;
}

test("a restart brings back the Preview tab italic, and the next click in the tree replaces it", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
  await treeItem(page, "List pets").dblclick();
  await treeItem(page, "Create pet").click();
  await expect.poll(() => savedPreview(page)).toEqual([["List pets", false], ["Create pet", true]]);

  await page.reload();
  await expect(tabNames(page)).toHaveText(["List pets", "Create pet"]);
  await expect.poll(() => italic(tab(page, "Create pet"))).toBe(true);
  expect(await italic(tab(page, "List pets"))).toBe(false);

  await treeItem(page, "Get pet image").click();
  await expect(tabNames(page)).toHaveText(["List pets", "Get pet image"]);
  expect(await italic(tab(page, "Get pet image"))).toBe(true);
});
