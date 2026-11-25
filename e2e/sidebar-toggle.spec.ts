// Collapsing and opening the sidebar (#95, #218): ⌘B / Ctrl+B and View → Show Sidebar
// switch it between open and the rail (the header's Collapse sidebar button and the
// rail itself: sidebar-rail.spec.ts). Collapsing keeps its width for when it opens
// again, the choice survives a reload, and Search Requests and Find usages open it first.
import { expect, test, type Page } from "@playwright/test";
import { menuClick, menuItem, openApp, openRequest, searchBox, treeItem } from "./helpers";

const aside = (page: Page) => page.locator("aside");
const separator = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Sidebar" });
const railButton = (page: Page, name: string) => rail(page).getByRole("button", { name, exact: true });

async function width(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())!.width);
}

async function expectHidden(page: Page) {
  await expect(aside(page)).toBeHidden();
  await expect(separator(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  // The work area takes the whole width beside the rail.
  expect(await width(page, ".work")).toBe((await width(page, ".main")) - (await width(page, "nav.rail")));
}

async function expectShown(page: Page, px = 280) {
  await expect(aside(page)).toBeVisible();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", String(px));
  await expect(rail(page)).toHaveCount(0);
  expect(await width(page, "aside")).toBe(px);
}

test("⌘B collapses the sidebar to the rail and opens it again at the width it had", async ({ page }) => {
  await openApp(page);
  await separator(page).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expectShown(page, 312);

  await page.locator(".work").click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  expect(await menuItem(page, "toggle-sidebar")).toMatchObject({ label: "Show Sidebar", accelerator: "Cmd+B", checked: false });

  await page.keyboard.press("Meta+B");
  await expectShown(page, 312);
  expect(await menuItem(page, "toggle-sidebar")).toMatchObject({ checked: true });
});

test("Ctrl+B toggles it on Windows and Linux", async ({ page }) => {
  await openApp(page, "?platform=windows");
  await page.keyboard.press("Control+B");
  await expectHidden(page);
  expect(await menuItem(page, "toggle-sidebar")).toMatchObject({ label: "Show Sidebar\tCtrl+B", accelerator: null });
  await page.keyboard.press("Control+B");
  await expectShown(page);
});

test("View → Show Sidebar toggles it", async ({ page }) => {
  await openApp(page);
  await menuClick(page, "toggle-sidebar");
  await expectHidden(page);
  await menuClick(page, "toggle-sidebar");
  await expectShown(page);
});

test("a collapsed sidebar stays collapsed after a reload, and comes back at its width", async ({ page }) => {
  await openApp(page);
  await separator(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expectShown(page, 264);
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.reload();
  await expect(rail(page)).toBeVisible();
  await expectHidden(page);
  await page.keyboard.press("Meta+B");
  await expectShown(page, 264);
});

test("⌘P opens a collapsed sidebar and focuses its search box", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.keyboard.press("Meta+P");
  await expectShown(page);
  await expect(searchBox(page)).toBeFocused();
});

test("Find usages opens a collapsed sidebar with its results", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.locator(".url-input .cm-var", { hasText: "{{baseUrl}}" }).first().hover();
  await page.locator(".popup-layer .var-card").getByRole("button", { name: "Find usages" }).click();
  await expectShown(page);
  await expect(page.getByRole("region", { name: /^Usages of / })).toContainText("Usages of {{baseUrl}}");
});

test("collapsing it while it has focus moves focus to the rail's marked button, not the page", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(railButton(page, "Explorer")).toBeFocused();

  // From its separator too.
  await page.keyboard.press("Meta+B");
  await separator(page).focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(railButton(page, "Explorer")).toBeFocused();

  // From the History view, to History's button.
  await page.keyboard.press("Meta+Shift+H");
  await expect(aside(page)).toBeVisible();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(railButton(page, "History")).toBeFocused();
});

test("collapsing it with focus in the work area leaves focus there", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  const tab = page.getByRole("tab", { selected: true });
  await tab.focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(tab).toBeFocused();
});

test("⌘B does nothing while a modal is open", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Meta+B");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectShown(page);
});
