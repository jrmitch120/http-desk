// The native menu bar (#101). The page sends its layout and item state to the
// shell; the mock records them (`menuItem`, `menuBar`) and fires menu clicks
// (`menuClick`) like the shell does. On macOS it also runs a menu item's key
// equivalent when the page leaves the key alone, like the real menu.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, dialog, menuBar, menuClick, menuItem, menuStateChanges, mockState, openApp, openRequest, sentRequests, tab, urlBar } from "./helpers";

async function editUrl(page: Page) {
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=2");
  await expect(activeTab(page).locator(".dot")).toBeVisible();
}

test.describe("the menu the page sends", () => {
  test("on macOS: the app menu, File, Edit, View, Request, Window and Help, with key equivalents", async ({ page }) => {
    await openApp(page);
    await expect.poll(() => menuBar(page)).toEqual(["HttpDesk", "File", "Edit", "View", "Request", "Window", "Help"]);
    expect(await menuItem(page, "save")).toMatchObject({ label: "Save", accelerator: "Cmd+S" });
  });

  test("on Windows: shortcuts in the labels, nothing bound", async ({ page }) => {
    await openApp(page, "?platform=windows");
    await expect.poll(() => menuBar(page)).toEqual(["File", "Edit", "View", "Request", "Help"]);
    expect(await menuItem(page, "save")).toMatchObject({ label: "Save\tCtrl+S", accelerator: null });
    expect(await menuItem(page, "quit")).toMatchObject({ label: "Exit\tAlt+F4" });
  });

  test("on Linux: nothing bound or shown, and the app's own Edit items", async ({ page }) => {
    await openApp(page, "?platform=linux");
    await expect.poll(() => menuBar(page)).toEqual(["File", "Edit", "View", "Request", "Help"]);
    expect(await menuItem(page, "quit")).toMatchObject({ label: "Quit", accelerator: null });
    expect(await menuItem(page, "copy")).toMatchObject({ label: "Copy", accelerator: null });
  });

  test("Open Recent lists the other recent workspaces, and is rebuilt when the list changes", async ({ page }) => {
    await openApp(page, "?recent=/work/shop,/work/api");
    await expect.poll(() => menuItem(page, "open-recent:/work/shop")).toMatchObject({ label: "shop" });
    expect(await menuItem(page, "open-recent:/demo")).toBeUndefined();

    await menuClick(page, "open-recent:/work/api");
    // The shell moves the opened workspace to the top of the list.
    await expect.poll(() => mockState(page, "settings").then((s) => s.recentWorkspaces)).toEqual(["/work/api", "/demo", "/work/shop"]);
    await expect.poll(() => recentOrder(page)).toEqual(["open-recent:/work/api", "open-recent:/work/shop"]);
  });
});

/** The ids under File → Open Recent, in order. */
async function recentOrder(page: Page): Promise<string[]> {
  const bar = await mockState(page, "menu");
  const file = bar.layout.find((m) => m.label === "File")!;
  const recent = file.items.find((e) => e.kind === "submenu" && e.label === "Open Recent") as { items: { id: string }[] };
  return recent.items.map((i) => i.id);
}

test.describe("menu clicks run commands", () => {
  test("File → Save saves the active request's file", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await editUrl(page);
    await menuClick(page, "save");
    await expect(activeTab(page).locator(".dot")).toHaveCount(0);
    expect(await mockState(page, "savedPaths")).toEqual(["/demo/api/pets.http"]);
  });

  test("Close Tab asks about unsaved edits, like the tab's Close button", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await editUrl(page);
    await menuClick(page, "close-tab");
    await dialog(page, 'Save changes to "List pets"?').getByRole("button", { name: "Don't save" }).click();
    await expect(tab(page, "List pets")).toHaveCount(0);
  });

  test("Request → Send sends the active request once", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await menuClick(page, "send");
    await expect(page.getByText("200 OK")).toBeVisible();
    expect(await sentRequests(page)).toHaveLength(1);
  });

  test("View → Theme switches the theme and ticks the choice", async ({ page }) => {
    await openApp(page);
    await expect.poll(() => menuItem(page, "theme-system")).toMatchObject({ checked: true });
    await menuClick(page, "theme-light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => menuItem(page, "theme-light")).toMatchObject({ checked: true });
    expect(await menuItem(page, "theme-system")).toMatchObject({ checked: false });
  });

  test("Request → Show .http Source shows the source and ticks the item", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await menuClick(page, "show-source");
    await expect(page.getByText("Read-only preview of how this request is written")).toBeVisible();
    await expect.poll(() => menuItem(page, "show-source")).toMatchObject({ checked: true });
    await page.getByRole("button", { name: ".http", exact: true }).click();
    await expect.poll(() => menuItem(page, "show-source")).toMatchObject({ checked: false });
  });

  test("Help → Check for Updates… checks and says when the app is up to date", async ({ page }) => {
    await openApp(page, "?platform=windows");
    await menuClick(page, "check-updates");
    await expect(page.getByText("HttpDesk is up to date.")).toBeVisible();
  });

  test("Linux's File → Quit goes through the window's close request", async ({ page }) => {
    await openApp(page, "?platform=linux");
    await menuClick(page, "quit");
    await expect.poll(() => mockState(page, "windowClosed")).toBe(true);
    expect(await mockState(page, "windowCloseRequests")).toBe(1);
  });

  test("a greyed-out command does nothing when its event arrives anyway", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await menuClick(page, "save");
    await menuClick(page, "cancel");
    await page.waitForTimeout(200);
    expect(await mockState(page, "savedPaths")).toEqual([]);
  });
});

test.describe("greyed-out and ticked state follows the app", () => {
  test("Send, Close Tab and Duplicate need a tab; Save and Save All need something unsaved", async ({ page }) => {
    await openApp(page);
    await expect.poll(() => menuItem(page, "send")).toMatchObject({ enabled: false });
    for (const id of ["close-tab", "duplicate-request", "save", "save-all", "cancel"]) expect(await menuItem(page, id), id).toMatchObject({ enabled: false });
    for (const id of ["new-request", "open-folder", "settings"]) expect(await menuItem(page, id), id).toMatchObject({ enabled: true });

    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect.poll(() => menuItem(page, "send")).toMatchObject({ enabled: true });
    expect(await menuItem(page, "close-tab")).toMatchObject({ enabled: true });
    expect(await menuItem(page, "save")).toMatchObject({ enabled: false });

    await editUrl(page);
    await expect.poll(() => menuItem(page, "save")).toMatchObject({ enabled: true });
    expect(await menuItem(page, "save-all")).toMatchObject({ enabled: true });
  });

  test("only the values that changed are sent, in one batch", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect.poll(() => menuItem(page, "send")).toMatchObject({ enabled: true });
    const before = (await menuStateChanges(page)).length;
    await editUrl(page);
    await expect.poll(() => menuStateChanges(page).then((c) => c.length)).toBe(before + 1);
    const batch = (await menuStateChanges(page)).at(-1)!;
    expect(batch).toEqual(
      expect.arrayContaining([
        { id: "save", enabled: true },
        { id: "save-all", enabled: true },
      ]),
    );
    expect(batch).toHaveLength(2);
  });

  test("Cancel is available while a request is in flight", async ({ page }) => {
    await openApp(page, "?download=slow");
    await openRequest(page, ["api", "pets.http"], "List pets");
    await menuClick(page, "send");
    await expect.poll(() => menuItem(page, "cancel")).toMatchObject({ enabled: true });
    await menuClick(page, "cancel");
    await expect(page.getByText("Request cancelled.")).toBeVisible();
    await expect.poll(() => menuItem(page, "cancel")).toMatchObject({ enabled: false });
  });

  test("while a modal is open every app command is greyed out, and Quit stays available", async ({ page }) => {
    await openApp(page, "?platform=linux");
    await openRequest(page, ["api", "pets.http"], "List pets");
    await editUrl(page);
    await expect.poll(() => menuItem(page, "save")).toMatchObject({ enabled: true });
    const appCommands = ["open-folder", "new-request", "save", "save-all", "close-tab", "close-window", "settings", "check-updates", "send", "show-source", "theme-dark", "layout-below"];

    await activeTab(page).focus();
    await page.keyboard.press("Control+Comma");
    await expect(dialog(page, "Settings")).toBeVisible();
    for (const id of appCommands) await expect.poll(() => menuItem(page, id), id).toMatchObject({ enabled: false });
    expect(await menuItem(page, "quit")).toMatchObject({ enabled: true });
    // A click that arrives anyway doesn't run.
    await menuClick(page, "save");
    await page.waitForTimeout(200);
    expect(await mockState(page, "savedPaths")).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog(page, "Settings")).toHaveCount(0);
    for (const id of appCommands) await expect.poll(() => menuItem(page, id), id).toMatchObject({ enabled: true });
  });

  test("a confirmation dialog greys out app commands too", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await editUrl(page);
    await menuClick(page, "close-tab");
    await expect(dialog(page, 'Save changes to "List pets"?')).toBeVisible();
    await expect.poll(() => menuItem(page, "send")).toMatchObject({ enabled: false });
    expect(await menuItem(page, "save")).toMatchObject({ enabled: false });
  });
});

test.describe("on macOS, menu key equivalents", () => {
  test("a key the page handles isn't run again by the menu", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await expect.poll(() => menuItem(page, "send")).toMatchObject({ enabled: true });
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByText("200 OK")).toBeVisible();

    await editUrl(page);
    await page.keyboard.press("Meta+S");
    await expect(activeTab(page).locator(".dot")).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await sentRequests(page)).toHaveLength(1);
    expect(await mockState(page, "savedPaths")).toEqual(["/demo/api/pets.http"]);
  });

  test("a key the page leaves alone runs the menu item", async ({ page }) => {
    await openApp(page);
    await openRequest(page, ["api", "pets.http"], "List pets");
    await editUrl(page);
    await expect.poll(() => menuItem(page, "save")).toMatchObject({ enabled: true });
    // Keep ⌘S from the page, as if it never handled it.
    await page.evaluate(() => window.addEventListener("keydown", (e) => e.stopImmediatePropagation(), { capture: true }));
    await page.keyboard.press("Meta+S");
    await expect.poll(() => mockState(page, "savedPaths")).toEqual(["/demo/api/pets.http"]);
  });
});
