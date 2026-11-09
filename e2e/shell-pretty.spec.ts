// The response Pretty view is formatted in the shell by response id (#61): a
// small body arrives with its Pretty text; a large one (`?largeBody=1`) is
// formatted on demand with `pretty_response` when Pretty is opened.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, releasePretty, resetPrettyRequests } from "./helpers";

const RAW = '{"items":[{"id":9007199254740993,"price":10.50,"name":"Rex"}],"method":"GET"}';

/** How many times the viewer asked the shell to format a response. */
function prettyRequests(page: Page): Promise<number> {
  return mockState(page, "prettyRequests");
}

async function send(page: Page, query: string) {
  await openApp(page, query);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
}

test("a small JSON response shows its Pretty text without asking the shell again", async ({ page }) => {
  await send(page, "?response=bigint");

  const body = page.locator(".body .cm-content");
  await expect(body).toContainText('"id": 9007199254740993,');
  await expect(body).toContainText('"price": 10.50,');
  expect(await prettyRequests(page)).toBe(0);
});

test("a large JSON response is formatted when Pretty is opened, with a loading state meanwhile", async ({ page }) => {
  await send(page, "?response=bigint&largeBody=1&pretty=hold");

  // Formatting is held until the test lets it through, so the loading state stays.
  await expect(page.getByRole("status").filter({ hasText: "Formatting…" })).toBeVisible();
  const body = page.locator(".body .cm-content");
  await expect(body).toHaveCount(0);
  await releasePretty(page);
  await expect(body).toContainText('"id": 9007199254740993,');
  await expect(page.getByRole("status").filter({ hasText: "Formatting…" })).toHaveCount(0);
  expect(await prettyRequests(page)).toBe(1);

  // Raw needs no formatting; back in Pretty, the text is already there.
  const views = page.getByRole("radiogroup", { name: "Response view" });
  await views.getByRole("radio", { name: "Raw" }).click();
  await expect(body).toHaveText(RAW);
  await views.getByRole("radio", { name: "Pretty" }).click();
  await expect(body).toContainText('"price": 10.50,');
  expect(await prettyRequests(page)).toBe(1);
});

test("a large response opened in Raw isn't formatted until Pretty is chosen", async ({ page }) => {
  await send(page, "?response=bigint&largeBody=1");
  const views = page.getByRole("radiogroup", { name: "Response view" });
  await expect(page.locator(".body .cm-content")).toContainText('"id": 9007199254740993,');
  await views.getByRole("radio", { name: "Raw" }).click();

  // The tab remembers Raw, so the next response isn't formatted.
  await resetPrettyRequests(page);
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText(/^Sending/)).toHaveCount(0);
  await expect(page.locator(".body .cm-content")).toHaveText(RAW);
  expect(await prettyRequests(page)).toBe(0);

  await views.getByRole("radio", { name: "Pretty" }).click();
  await expect(page.locator(".body .cm-content")).toContainText('"price": 10.50,');
  expect(await prettyRequests(page)).toBe(1);
});

test("a response whose stored body was evicted shows its raw body in Pretty view", async ({ page }) => {
  await send(page, "?response=bigint&largeBody=1&evicted=1");

  await expect(page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Pretty" })).toBeChecked();
  await expect(page.locator(".body .cm-content")).toHaveText(RAW);
  await expect(page.getByRole("status").filter({ hasText: "Formatting…" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
