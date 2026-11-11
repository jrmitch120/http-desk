// The shell keeps each tab's response until the tab lets it go (#109): closing the
// tab or getting a newer response releases the old one; cancelling a send doesn't.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, tab } from "./helpers";

const body = (page: Page) => page.locator(".body .cm-content");
const status = (page: Page) => page.locator(".statusbar");

async function sendListPets(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

test("closing a tab releases its response, and only that one", async ({ page }) => {
  await openApp(page, "?platform=mac");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendListPets(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await sendListPets(page);
  expect(await mockState(page, "releasedResponses")).toEqual([]);

  await page.keyboard.press("Meta+W");

  await expect(tab(page, "Create pet")).toHaveCount(0);
  await expect.poll(() => mockState(page, "releasedResponses")).toEqual(["r1-2"]);
  await expect(body(page)).toContainText('"items"');
});

test("re-sending releases the previous response once the new one is in", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendListPets(page);

  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".loading")).toBeVisible();
  expect(await mockState(page, "releasedResponses")).toEqual([]);

  await expect.poll(() => mockState(page, "releasedResponses")).toEqual(["r1-1"]);
  await expect(body(page)).toContainText('"items"');
});

test("re-sending a binary response releases the old body, and the new one's Hex still shows", async ({ page }) => {
  await openApp(page, "?bigBinary=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await sendListPets(page);
  const hex = page.locator(".body .cm-content");
  await expect(hex).toContainText("00000000  00 00 00");

  await sendListPets(page);
  await expect.poll(async () => (await mockState(page, "releasedResponses")).length).toBe(1);

  await expect(hex).toContainText("00000000  00 00 00");
  await expect(page.getByText("Response is no longer available")).toHaveCount(0);
});

test("a cancelled send releases nothing, and its tab still shows the previous response", async ({ page }) => {
  await openApp(page, "?download=slow");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await sendListPets(page);

  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".loading .received")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).first().click();

  await expect(page.getByText("Cancelled")).toBeVisible();
  await expect(body(page)).toContainText('"items"');
  expect(await mockState(page, "releasedResponses")).toEqual([]);
});
