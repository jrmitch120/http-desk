// A body's editor document is built from the fetched bytes in pieces, with
// "Preparing…" shown meanwhile, and kept per tab and view (#113): switching
// tabs, or views, and back shows it again without fetching it again.
// `?body=hold` holds every `response_body` fetch until the test lets it through.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, releaseBody, tab } from "./helpers";

const body = (page: Page) => page.locator(".body .cm-content");
const preparing = (page: Page) => page.getByRole("status").filter({ hasText: "Preparing…" });
const views = (page: Page) => page.getByRole("radiogroup", { name: "Response view" });

test("Preparing… shows while the body is on its way, then the body shows", async ({ page }) => {
  await openApp(page, "?body=hold");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await expect(page.locator(".statusbar")).toContainText("200 OK");
  await expect(preparing(page)).toBeVisible();
  await expect(body(page)).toHaveCount(0);

  await releaseBody(page);
  await expect(body(page)).toContainText('"items": [');
  await expect(preparing(page)).toHaveCount(0);
});

test("switching to another tab and back doesn't fetch the body again", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(body(page)).toContainText('"items": [');
  await views(page).getByRole("radio", { name: "Raw" }).click();
  await expect(body(page)).toContainText('{"items":[');
  await views(page).getByRole("radio", { name: "Pretty" }).click();
  await expect(body(page)).toContainText('"items": [');
  const fetched = await mockState(page, "bodyRequests");
  expect(fetched.map((r) => r.view)).toEqual(["pretty", "raw"]);

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(page.getByText("to get a response")).toBeVisible();
  await tab(page, "List pets").click();
  await expect(body(page)).toContainText('"items": [');
  await views(page).getByRole("radio", { name: "Raw" }).click();
  await expect(body(page)).toContainText('{"items":[');

  expect(await mockState(page, "bodyRequests")).toEqual(fetched);
});

test("a re-sent response's body is fetched again", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(body(page)).toContainText('"items": [');

  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await mockState(page, "bodyRequests")).length).toBe(2);
  const [first, second] = await mockState(page, "bodyRequests");
  expect(second.id).not.toBe(first.id);
  await expect(body(page)).toContainText('"items": [');
  await expect(preparing(page)).toHaveCount(0);
});
