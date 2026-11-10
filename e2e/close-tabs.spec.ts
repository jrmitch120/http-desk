import { expect, test } from "@playwright/test";
import { activeTab, dialog, mockState, openApp, openRequest, tab, treeItem, urlBar } from "./helpers";

// ⌘W on macOS, Ctrl+W elsewhere: the OS is forced with `?platform=`, so each
// test presses that OS's keys whatever machine runs it.
const closeTabKeys = [
  { os: "mac", closeTab: "Meta+W" },
  { os: "windows", closeTab: "Control+W" },
  { os: "linux", closeTab: "Control+W" },
];

for (const { os, closeTab } of closeTabKeys) {
  test(`on ${os}, ${closeTab} closes the active tab and leaves the others`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    for (const name of ["List pets", "Create pet"]) await openRequest(page, ["api", "pets.http"], name);
    await urlBar(page).click();

    await page.keyboard.press(closeTab);

    await expect(tab(page, "Create pet")).toHaveCount(0);
    await expect(activeTab(page)).toContainText("List pets");
  });
}

test("⌘W on a tab with unsaved edits asks first, like its Close button", async ({ page }) => {
  await openApp(page, "?platform=mac");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=2");

  await page.keyboard.press("Meta+W");
  const confirm = dialog(page, 'Save changes to "List pets"?');
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(tab(page, "List pets")).toBeVisible();

  await page.keyboard.press("Meta+W");
  await confirm.getByRole("button", { name: "Don't save" }).click();
  await expect(tab(page, "List pets")).toHaveCount(0);
  expect(await mockState(page, "windowCloseRequests")).toBe(0);
});

test("Ctrl+W with no tab open does nothing, and never closes the window", async ({ page }) => {
  await openApp(page, "?platform=windows");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Control+W");
  await expect(tab(page, "List pets")).toHaveCount(0);

  await page.keyboard.press("Control+W");

  await expect(treeItem(page, "api")).toBeVisible();
  expect(await mockState(page, "windowCloseRequests")).toBe(0);
});

test("⌘W with a modal open leaves the modal and the tab open", async ({ page }) => {
  await openApp(page, "?platform=mac");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Comma");
  const settings = dialog(page, "Settings");
  await expect(settings).toBeVisible();

  await page.keyboard.press("Meta+W");

  await expect(settings).toBeVisible();
  await expect(tab(page, "List pets")).toBeVisible();
});

test("⌘⇧W closes the window when nothing is unsaved", async ({ page }) => {
  await openApp(page, "?platform=mac");
  await openRequest(page, ["api", "pets.http"], "List pets");

  await page.keyboard.press("Meta+Shift+W");

  await expect.poll(() => mockState(page, "windowClosed")).toBe(true);
  await expect(tab(page, "List pets")).toBeVisible(); // the window closes, not the tab
});

test("Ctrl+Shift+W asks about unsaved files before closing the window, and Cancel keeps it open", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=2");

  await page.keyboard.press("Control+Shift+W");
  await dialog(page, "Unsaved changes").getByRole("button", { name: "Cancel" }).click();

  expect(await mockState(page, "windowCloseRequests")).toBe(1);
  expect(await mockState(page, "windowClosed")).toBe(false);
  await expect(tab(page, "List pets")).toBeVisible();
});

test("Close all asks about each unsaved tab in turn, and Cancel keeps the rest open", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet", "Get pet image"]) {
    await openRequest(page, ["api", "pets.http"], name);
    await urlBar(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
  }

  await tab(page, "Create pet").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all", exact: true }).click();

  await dialog(page, 'Save changes to "List pets"?').getByRole("button", { name: "Don't save" }).click();
  await dialog(page, 'Save changes to "Create pet"?').getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tab(page, "List pets")).toHaveCount(0);
  await expect(tab(page, "Create pet")).toBeVisible();
  await expect(tab(page, "Get pet image")).toBeVisible();
});

test("every item in a tab's menu has an icon", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await tab(page, "List pets").click({ button: "right" });
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items).toHaveText(["Close", "Close others", "Close all", "Duplicate request"]);
  await expect(items.filter({ has: page.locator(".ico svg path:not([d=''])") })).toHaveCount(4);
});
