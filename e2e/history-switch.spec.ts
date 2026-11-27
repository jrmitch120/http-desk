// The History switch and Settings → History (#154): History is on by default; turning
// it off asks whether to also delete what's stored (Keep or Delete); while it's off
// the History views say "History is off" with a link to the setting. Settings shows
// where History is kept and clears it all after confirming. The sidebar's History
// view (#156) says it's off too.
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, settingsPage, showSettingsPage } from "./helpers";

const historyButton = (page: Page) => page.getByRole("radiogroup", { name: "Response pane" }).getByRole("radio", { name: "History" });
const entries = (page: Page) => page.getByRole("list", { name: "History entries" }).getByRole("listitem");

async function send(page: Page) {
  const before = (await mockState(page, "history")).length;
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await mockState(page, "history")).length).toBe(before + 1);
}

async function openSettings(page: Page) {
  await page.keyboard.press("Meta+Comma");
  await showSettingsPage(page, "History");
  return dialog(page, "Settings");
}

const historySection = (page: Page) => settingsPage(page, "History");
const historySwitch = (page: Page) => historySection(page).getByRole("switch", { name: "Record History" });

test("History is on by default; turning it off with Keep keeps what's stored and records nothing more", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await openSettings(page);
  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "true");
  await historySwitch(page).click();
  const ask = dialog(page, "Also delete existing history?");
  await expect(ask.getByRole("button", { name: "Keep" })).toBeVisible();
  await expect(ask.getByRole("button", { name: "Delete" })).toBeVisible();
  await ask.getByRole("button", { name: "Keep" }).click();

  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await mockState(page, "settings")).history.enabled).toBe(false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar").first().locator(".metric", { hasText: "Size" })).toBeVisible();
  expect(await mockState(page, "history")).toHaveLength(1);

  // Back on: the kept entry is listed again.
  await openSettings(page);
  await historySwitch(page).click();
  await expect(dialog(page, "Also delete existing history?")).toHaveCount(0);
  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(1);
});

test("turning History off with Delete deletes what's stored; the History view says it's off and links to the setting", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(1);

  await openSettings(page);
  await historySwitch(page).click();
  await dialog(page, "Also delete existing history?").getByRole("button", { name: "Delete" }).click();
  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => mockState(page, "history")).toEqual([]);
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("History is off")).toBeVisible();
  await expect(entries(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Turn it on in Settings" }).click();
  await expect(historySwitch(page)).toBeInViewport();
  await historySwitch(page).click();
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("History is off")).toHaveCount(0);
  await expect(page.getByText("No History for this request yet")).toBeVisible();
});

test("the sidebar's History view says History is off and links to the setting", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
  const sidebar = page.getByRole("region", { name: "Workspace History" });
  await expect(sidebar.getByRole("list", { name: "History entries" }).getByRole("listitem")).toHaveCount(1);

  await openSettings(page);
  await historySwitch(page).click();
  await dialog(page, "Also delete existing history?").getByRole("button", { name: "Keep" }).click();
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();

  await expect(sidebar.getByText("History is off")).toBeVisible();
  await expect(sidebar.getByRole("list", { name: "History entries" })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Turn it on in Settings" }).click();
  await expect(historySwitch(page)).toBeInViewport();
  await historySwitch(page).click();
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();

  // Back on: the kept entry is listed again.
  await expect(sidebar.getByText("History is off")).toHaveCount(0);
  await expect(sidebar.getByRole("list", { name: "History entries" }).getByRole("listitem")).toHaveCount(1);
});

test("Settings shows where History is kept, and Clear all history empties it once confirmed", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page);
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(2);

  await openSettings(page);
  await expect(historySection(page)).toContainText("io.github.jrmitch120.httpdesk/history.sqlite3");
  const clear = historySection(page).getByRole("button", { name: "Clear all history" });
  await clear.click();
  await dialog(page, "Clear all history?").getByRole("button", { name: "Cancel" }).click();
  expect(await mockState(page, "history")).toHaveLength(2);

  await clear.click();
  await dialog(page, "Clear all history?").getByRole("button", { name: "Clear all history" }).click();
  await expect(page.getByText("History cleared")).toBeVisible();
  expect(await mockState(page, "history")).toEqual([]);
  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "true");
  await dialog(page, "Settings").getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("No History for this request yet")).toBeVisible();
});

test("Cancel leaves History on", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await historySwitch(page).click();
  await dialog(page, "Also delete existing history?").getByRole("button", { name: "Cancel" }).click();

  await expect(historySwitch(page)).toHaveAttribute("aria-checked", "true");
  expect((await mockState(page, "settings")).history.enabled).toBe(true);
});
