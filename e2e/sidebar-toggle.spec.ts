// Hiding and showing the sidebar (#95): ⌘B / Ctrl+B, View → Show Sidebar and the
// TopBar button. Hiding keeps its width for when it's shown again, the choice
// survives a reload, and Search Requests and Find usages show it first.
import { expect, test, type Page } from "@playwright/test";
import { menuClick, menuItem, openApp, openRequest, searchBox, treeItem } from "./helpers";

const aside = (page: Page) => page.locator("aside");
const separator = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" });
const toggleButton = (page: Page) => page.getByRole("button", { name: "Show sidebar", exact: true });

async function width(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())!.width);
}

async function expectHidden(page: Page) {
  await expect(aside(page)).toBeHidden();
  await expect(separator(page)).toHaveCount(0);
  await expect(toggleButton(page)).toHaveAttribute("aria-pressed", "false");
  // The work area takes the whole width.
  expect(await width(page, ".work")).toBe(await width(page, ".main"));
}

async function expectShown(page: Page, px = 280) {
  await expect(aside(page)).toBeVisible();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", String(px));
  await expect(toggleButton(page)).toHaveAttribute("aria-pressed", "true");
  expect(await width(page, "aside")).toBe(px);
}

test("⌘B hides the sidebar and shows it again at the width it had", async ({ page }) => {
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

test("the TopBar button toggles it, shows it pressed while shown, and its tooltip shows the shortcut", async ({ page }) => {
  await openApp(page);
  await toggleButton(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Show sidebar (⌘B)");
  await expect(toggleButton(page)).toHaveClass(/\bactive\b/);

  await toggleButton(page).click();
  await expectHidden(page);
  await expect(toggleButton(page)).not.toHaveClass(/\bactive\b/);

  await toggleButton(page).click();
  await expectShown(page);
});

test("View → Show Sidebar toggles it", async ({ page }) => {
  await openApp(page);
  await menuClick(page, "toggle-sidebar");
  await expectHidden(page);
  await menuClick(page, "toggle-sidebar");
  await expectShown(page);
});

test("a hidden sidebar stays hidden after a reload, and comes back at its width", async ({ page }) => {
  await openApp(page);
  await separator(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expectShown(page, 264);
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.reload();
  await expect(toggleButton(page)).toBeVisible();
  await expectHidden(page);
  await page.keyboard.press("Meta+B");
  await expectShown(page, 264);
});

test("⌘P shows a hidden sidebar and focuses its search box", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.keyboard.press("Meta+P");
  await expectShown(page);
  await expect(searchBox(page)).toBeFocused();
});

test("Find usages shows a hidden sidebar with its results", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+B");
  await expectHidden(page);

  await page.locator(".url-input .cm-var", { hasText: "{{baseUrl}}" }).first().hover();
  await page.locator(".popup-layer .var-card").getByRole("button", { name: "Find usages" }).click();
  await expectShown(page);
  await expect(page.getByRole("region", { name: /^Usages of / })).toContainText("Usages of {{baseUrl}}");
});

test("hiding it while it has focus moves focus to the work area, not the page", async ({ page }) => {
  await openApp(page);
  const newRequest = page.getByRole("button", { name: "New request", exact: true });
  await treeItem(page, "api").focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(newRequest).toBeFocused();

  // From its separator too.
  await page.keyboard.press("Meta+B");
  await separator(page).focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(newRequest).toBeFocused();

  // With a request open, its tab takes focus.
  await page.keyboard.press("Meta+B");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await treeItem(page, "List pets").focus();
  await page.keyboard.press("Meta+B");
  await expectHidden(page);
  await expect(page.getByRole("tab", { selected: true })).toBeFocused();
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
