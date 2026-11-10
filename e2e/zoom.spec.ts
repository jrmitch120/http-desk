// Zooming the whole interface (#94): Zoom In, Zoom Out and Actual Size from the
// keyboard and the View menu, one level at a time between 50% and 150%, saved
// across a reload. The mock records the webview zoom the app sets
// (`plugin:webview|set_webview_zoom`) rather than zooming the page.
import { expect, test, type Page } from "@playwright/test";
import { menuClick, menuItem, mockState, openApp } from "./helpers";

/** The page's window, with the last keydown recorded on it. */
type Recording = { __lastKey: KeyboardEvent | null };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Recording;
    // The last keydown, to check a key the app took was swallowed.
    w.__lastKey = null;
    window.addEventListener("keydown", (e) => (w.__lastKey = e), true);
  });
});

/** The zoom the webview is at now, and the zoom saved in settings. */
async function expectZoom(page: Page, zoom: number) {
  await expect.poll(() => mockState(page, "webviewZoom")).toBe(zoom);
  await expect.poll(async () => (await mockState(page, "settings")).zoom).toBe(zoom);
}

/** Whether Zoom In, Zoom Out and Actual Size are enabled in the View menu. */
async function enabled(page: Page) {
  return Promise.all(["zoom-in", "zoom-out", "zoom-reset"].map(async (id) => (await menuItem(page, id))?.enabled));
}

const lastKeyPrevented = (page: Page) =>
  page.evaluate(() => (window as unknown as Recording).__lastKey?.defaultPrevented ?? null);

/** A keydown as a layout produces it (`key` with these modifiers), on the focused element. */
const keydown = (page: Page, init: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) =>
  page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })), init);

test("⌘= zooms in a level, ⌘- zooms out a level and ⌘0 goes back to 100%", async ({ page }) => {
  await openApp(page);
  await expectZoom(page, 1);
  expect(await menuItem(page, "zoom-in")).toMatchObject({ label: "Zoom In", accelerator: "Cmd+=" });
  expect(await menuItem(page, "zoom-out")).toMatchObject({ label: "Zoom Out", accelerator: "Cmd+-" });
  expect(await menuItem(page, "zoom-reset")).toMatchObject({ label: "Actual Size", accelerator: "Cmd+0" });

  // One level per press: the page swallows the key, so the menu's ⌘= doesn't run it again (ADR-0005).
  await page.keyboard.press("Meta+Equal");
  await expectZoom(page, 1.1);
  expect(await lastKeyPrevented(page)).toBe(true);
  await page.keyboard.press("Meta+Equal");
  await expectZoom(page, 1.25);
  await page.keyboard.press("Meta+Minus");
  await expectZoom(page, 1.1);
  await page.keyboard.press("Meta+Minus");
  await page.keyboard.press("Meta+Minus");
  await expectZoom(page, 0.9);
  await page.keyboard.press("Meta+0");
  await expectZoom(page, 1);
});

test("⌘+ zooms in too, with or without Shift", async ({ page }) => {
  await openApp(page);
  // ⌘+ on a US keyboard: Shift and =.
  await page.keyboard.press("Meta+Shift+Equal");
  await expectZoom(page, 1.1);
  // The keypad's +.
  await page.keyboard.press("Meta+NumpadAdd");
  await expectZoom(page, 1.25);
  // A layout where = needs Shift.
  expect(await keydown(page, { key: "=", shiftKey: true, metaKey: true })).toBe(false);
  await expectZoom(page, 1.5);
});

test("Ctrl+=, Ctrl+- and Ctrl+0 zoom on Windows, shown in the menu labels", async ({ page }) => {
  await openApp(page, "?platform=windows");
  expect(await menuItem(page, "zoom-in")).toMatchObject({ label: "Zoom In\tCtrl+=", accelerator: null });
  expect(await menuItem(page, "zoom-out")).toMatchObject({ label: "Zoom Out\tCtrl+-", accelerator: null });
  expect(await menuItem(page, "zoom-reset")).toMatchObject({ label: "Actual Size\tCtrl+0", accelerator: null });
  await page.keyboard.press("Control+Equal");
  await expectZoom(page, 1.1);
  await page.keyboard.press("Control+Shift+Equal");
  await expectZoom(page, 1.25);
  await page.keyboard.press("Control+Minus");
  await expectZoom(page, 1.1);
  await page.keyboard.press("Control+0");
  await expectZoom(page, 1);
});

test("Linux shows no shortcuts in the menu, and Ctrl+= still zooms", async ({ page }) => {
  await openApp(page, "?platform=linux");
  expect(await menuItem(page, "zoom-in")).toMatchObject({ label: "Zoom In", accelerator: null });
  await page.keyboard.press("Control+Equal");
  await expectZoom(page, 1.1);
});

test("View → Zoom In, Zoom Out and Actual Size run the same commands", async ({ page }) => {
  await openApp(page);
  await menuClick(page, "zoom-in");
  await expectZoom(page, 1.1);
  await menuClick(page, "zoom-out");
  await menuClick(page, "zoom-out");
  await expectZoom(page, 0.9);
  await menuClick(page, "zoom-reset");
  await expectZoom(page, 1);
});

test("the menu items are disabled at the limits, where their keys do nothing but are still swallowed", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => enabled(page)).toEqual([true, true, false]);

  for (let i = 0; i < 3; i++) await page.keyboard.press("Meta+Equal");
  await expectZoom(page, 1.5);
  await expect.poll(() => enabled(page)).toEqual([false, true, true]);
  await page.keyboard.press("Meta+Equal");
  expect(await lastKeyPrevented(page)).toBe(true);
  await expectZoom(page, 1.5);

  for (let i = 0; i < 8; i++) await page.keyboard.press("Meta+Minus");
  await expectZoom(page, 0.5);
  await expect.poll(() => enabled(page)).toEqual([true, false, true]);
  await page.keyboard.press("Meta+Minus");
  expect(await lastKeyPrevented(page)).toBe(true);
  await expectZoom(page, 0.5);

  await page.keyboard.press("Meta+0");
  await expectZoom(page, 1);
  await page.keyboard.press("Meta+0");
  expect(await lastKeyPrevented(page)).toBe(true);
  await expect.poll(() => enabled(page)).toEqual([true, true, false]);
});

test("doesn't zoom while a modal is open", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Meta+Equal");
  expect(await lastKeyPrevented(page)).toBe(true);
  await expect.poll(async () => (await menuItem(page, "zoom-in"))?.enabled).toBe(false);
  await expectZoom(page, 1);
});

test("the zoom is saved and applied again after a reload", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expectZoom(page, 1.25);

  await page.reload();
  await expectZoom(page, 1.25);
  await expect.poll(() => enabled(page)).toEqual([true, true, true]);
});
