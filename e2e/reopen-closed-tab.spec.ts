import { expect, test } from "@playwright/test";
import { activeTab, dialog, menuClick, menuItem, mockState, openApp, openRequest, tab, treeItem, treeMenu, urlBar } from "./helpers";

// ⌘⇧T on macOS, Ctrl+Shift+T elsewhere: the OS is forced with `?platform=`,
// so each test presses that OS's keys whatever machine runs it.
const reopenKeys = [
  { os: "mac", closeTab: "Meta+W", reopen: "Meta+Shift+T" },
  { os: "windows", closeTab: "Control+W", reopen: "Control+Shift+T" },
  { os: "linux", closeTab: "Control+W", reopen: "Control+Shift+T" },
];

for (const { os, closeTab, reopen } of reopenKeys) {
  test(`on ${os}, ${reopen} reopens the tab just closed, at the same request, made active`, async ({ page }) => {
    await openApp(page, `?platform=${os}`);
    for (const name of ["List pets", "Create pet"]) await openRequest(page, ["api", "pets.http"], name);
    await page.keyboard.press(closeTab);
    await expect(tab(page, "Create pet")).toHaveCount(0);
    await urlBar(page).click(); // the keys work from inside an editor too

    await page.keyboard.press(reopen);

    await expect(activeTab(page)).toContainText("Create pet");
    await expect(tab(page, "List pets")).toBeVisible();
  });
}

test("pressing it again reopens earlier closed tabs in reverse order, so Close others undoes tab by tab", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet", "Get pet image"]) await openRequest(page, ["api", "pets.http"], name);
  const tabs = page.getByRole("tablist", { name: "Open requests" }).getByRole("tab");
  await expect(tabs).toHaveText([/List pets/, /Create pet/, /Get pet image/]);

  await tab(page, "Create pet").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close others", exact: true }).click();
  await expect(tabs).toHaveText([/Create pet/]);

  await page.keyboard.press("Meta+Shift+T");
  await expect(tabs).toHaveText([/Create pet/, /Get pet image/]);
  await expect(activeTab(page)).toContainText("Get pet image");

  await page.keyboard.press("Meta+Shift+T");
  await expect(tabs).toHaveText([/List pets/, /Create pet/, /Get pet image/]);
  await expect(activeTab(page)).toContainText("List pets");

  await page.keyboard.press("Meta+Shift+T"); // nothing left to reopen
  await expect(tabs).toHaveText([/List pets/, /Create pet/, /Get pet image/]);
  await expect(activeTab(page)).toContainText("List pets");
});

test("a closed tab whose request was deleted is skipped, and the one closed before it reopens", async ({ page }) => {
  await openApp(page);
  for (const name of ["List pets", "Create pet"]) await openRequest(page, ["api", "pets.http"], name);
  await page.keyboard.press("Meta+W"); // Create pet
  await page.keyboard.press("Meta+W"); // List pets
  await expect(tab(page, "List pets")).toHaveCount(0);
  await treeMenu(page, "Create pet", "Delete");
  await dialog(page, "Delete request").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "Create pet")).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+T");

  await expect(activeTab(page)).toContainText("List pets");
  await expect(tab(page, "Create pet")).toHaveCount(0);
});

test("opening another workspace forgets the closed tabs", async ({ page }) => {
  await openApp(page, "?roots=/work/shop&recent=/work/shop");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+W");
  await expect.poll(() => menuItem(page, "reopen-tab")).toMatchObject({ enabled: true });

  // A workspace of its own (`?roots=`).
  await menuClick(page, "open-recent:/work/shop");
  await expect.poll(() => mockState(page, "settings").then((s) => s.recentWorkspaces[0])).toBe("/work/shop");
  await treeItem(page, "api").click();
  await treeItem(page, "pets.http").click();
  await expect(treeItem(page, "List pets")).toBeVisible();

  await expect.poll(() => menuItem(page, "reopen-tab")).toMatchObject({ enabled: false });
  await page.keyboard.press("Meta+Shift+T");
  await expect(tab(page, "List pets")).toHaveCount(0);
});

test("File → Reopen Closed Tab reopens it too, and is greyed out with nothing to reopen", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => menuItem(page, "reopen-tab")).toMatchObject({ label: "Reopen Closed Tab", accelerator: "Cmd+Shift+T", enabled: false });
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+W");
  await expect.poll(() => menuItem(page, "reopen-tab")).toMatchObject({ enabled: true });

  await menuClick(page, "reopen-tab");

  await expect(activeTab(page)).toContainText("List pets");
  await expect.poll(() => menuItem(page, "reopen-tab")).toMatchObject({ enabled: false });
});
