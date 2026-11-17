// History (#151): every send from a tab is recorded, and the request's History view in
// the response pane lists its entries newest first. An entry opens read-only in the
// response viewer, as a response of its own (ADR-0006): its body previews and saves
// like a live one's, and going back to the list releases it.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, setMockResponse } from "./helpers";

const status = (page: Page) => page.locator(".statusbar").first();
const historyButton = (page: Page) => page.getByRole("button", { name: "History", exact: true });
const entries = (page: Page) => page.getByRole("list", { name: "History entries" }).getByRole("listitem");

async function send(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

test("a request with no response yet has a History view, empty until it's sent", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  await historyButton(page).click();

  await expect(historyButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("No History for this request yet")).toBeVisible();
});

test("sending twice lists two entries newest first, and an entry opens read-only with its body and headers", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await setMockResponse(page, "text");
  await send(page);

  await historyButton(page).click();

  await expect(entries(page)).toHaveCount(2);
  // Newest first: the text response (17 B), then the JSON one.
  await expect(entries(page).nth(0)).toContainText("GET");
  await expect(entries(page).nth(0)).toContainText("200");
  await expect(entries(page).nth(0)).toContainText("17 B");
  await expect(entries(page).nth(1)).not.toContainText("17 B");

  await entries(page).nth(1).getByRole("button").click();

  const entry = page.getByRole("region", { name: "History entry" });
  await expect(entry.locator(".body .cm-content")).toContainText('"name": "Rex"');
  await entry.getByRole("radio", { name: /Headers/ }).click();
  await expect(entry.getByText("application/json")).toBeVisible();
  await entry.getByRole("radio", { name: "Request" }).click();
  // The request as sent, its credentials masked.
  await expect(entry.getByText("••••••••")).toBeVisible();
  await expect(entry.getByText("dev-token-123")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to History" }).click();
  await expect(entries(page)).toHaveCount(2);
  const released = await mockState(page, "releasedResponses");
  expect(released.filter((id) => id.startsWith("h-"))).toHaveLength(1);
});

test("a binary entry previews like a live response, and its body saves to a file", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await send(page);
  await historyButton(page).click();

  await entries(page).first().getByRole("button").click();

  const entry = page.getByRole("region", { name: "History entry" });
  const img = entry.getByRole("img", { name: "Response preview" });
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(128);

  await entry.getByRole("button", { name: "Save body to file" }).click();
  const saved = () => mockState(page, "savedBodies");
  await expect.poll(async () => Object.values(await saved())).toHaveLength(1);
  expect(Object.values(await saved())[0]).toMatch(/^iVBORw0KGgo/);
});

test("History survives a page reload, as it does a restart", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await page.reload();
  await openRequest(page, ["api", "pets.http"], "List pets");
  await historyButton(page).click();

  await expect(entries(page)).toHaveCount(1);
});
