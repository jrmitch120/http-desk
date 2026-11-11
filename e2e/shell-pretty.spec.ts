// Raw and Pretty show text the viewer fetches from the shell by response id
// (`response_body`, #110), never text from the send reply. Each view fetches
// only its own text, once per response. `?largeBody=1` makes Pretty slow to
// format, and `?pretty=hold` holds it until the test lets it through.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, releasePretty, resetBodyRequests } from "./helpers";

const RAW = '{"items":[{"id":9007199254740993,"price":10.50,"name":"Rex"}],"method":"GET"}';

/** The views the viewer fetched, in order. */
async function fetchedViews(page: Page): Promise<string[]> {
  return (await mockState(page, "bodyRequests")).map((r) => r.view);
}

async function send(page: Page, query: string) {
  await openApp(page, query);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
}

test("Pretty fetches only the Pretty text, and Raw only the raw text, each once per response", async ({ page }) => {
  await send(page, "?response=bigint");

  const body = page.locator(".body .cm-content");
  await expect(body).toContainText('"id": 9007199254740993,');
  await expect(body).toContainText('"price": 10.50,');
  expect(await fetchedViews(page)).toEqual(["pretty"]);

  const views = page.getByRole("radiogroup", { name: "Response view" });
  await views.getByRole("radio", { name: "Raw" }).click();
  await expect(body).toHaveText(RAW);
  await views.getByRole("radio", { name: "Pretty" }).click();
  await expect(body).toContainText('"price": 10.50,');
  await views.getByRole("radio", { name: "Raw" }).click();
  await expect(body).toHaveText(RAW);
  expect(await fetchedViews(page)).toEqual(["pretty", "raw"]);
  const [first, second] = await mockState(page, "bodyRequests");
  expect(second.id).toBe(first.id);
});

test("a slow Pretty text shows a loading state until it arrives", async ({ page }) => {
  await send(page, "?response=bigint&largeBody=1&pretty=hold");

  // The Pretty text is held until the test lets it through, so the loading state stays.
  await expect(page.getByRole("status").filter({ hasText: "Preparing…" })).toBeVisible();
  const body = page.locator(".body .cm-content");
  await expect(body).toHaveCount(0);
  await releasePretty(page);
  await expect(body).toContainText('"id": 9007199254740993,');
  await expect(page.getByRole("status").filter({ hasText: "Preparing…" })).toHaveCount(0);
});

test("a tab left in Raw doesn't fetch the next response's Pretty text", async ({ page }) => {
  await send(page, "?response=bigint&largeBody=1");
  const views = page.getByRole("radiogroup", { name: "Response view" });
  await expect(page.locator(".body .cm-content")).toContainText('"id": 9007199254740993,');
  await views.getByRole("radio", { name: "Raw" }).click();
  await expect(page.locator(".body .cm-content")).toHaveText(RAW);

  // The tab remembers Raw, so the next response isn't formatted.
  await resetBodyRequests(page);
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText(/^Sending/)).toHaveCount(0);
  await expect.poll(() => fetchedViews(page)).toEqual(["raw"]);
  await expect(page.locator(".body .cm-content")).toHaveText(RAW);

  await views.getByRole("radio", { name: "Pretty" }).click();
  await expect(page.locator(".body .cm-content")).toContainText('"price": 10.50,');
  expect(await fetchedViews(page)).toEqual(["raw", "pretty"]);
});

test("a response whose stored body is gone says so in Pretty and Raw", async ({ page }) => {
  await send(page, "?response=bigint&evicted=1");

  await expect(page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Pretty" })).toBeChecked();
  const body = page.locator(".body .cm-content");
  await expect(body).toHaveText("(Response is no longer available)");
  await page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Raw" }).click();
  await expect(body).toHaveText("(Response is no longer available)");
});
