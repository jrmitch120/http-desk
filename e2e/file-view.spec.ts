// A whole .http file as one text (#166): its own tab, opened from a request tab, the
// explorer or the Request menu. It and the file's request tabs edit the same document,
// so an edit in one shows in the other; requests and bodies fold; it comes back with
// the Layout.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, menuClick, mockState, openApp, openRequest, tab, treeItem, treeMenu } from "./helpers";

const fileView = (page: Page) => page.locator(".file-view .file-code");
const line = (page: Page, text: string) => fileView(page).locator(".cm-line", { hasText: text });
const viewAsText = (page: Page) => page.getByRole("button", { name: "View file as text" });
/** The Headers table's rows as `name: value` (the new-row ghost left out). */
const headerRows = (page: Page) =>
  page
    .locator(".kv-row")
    .filter({ has: page.getByRole("button", { name: "Delete" }) })
    .evaluateAll((rows) =>
      rows.map((row) => `${row.querySelector<HTMLInputElement>(".c-name")!.value}: ${row.querySelector(".c-value")!.textContent}`),
    );

test("an edit to the second request's header in the file view shows in that request's tab", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(line(page, "@petId = 1")).toBeVisible();

  await line(page, "Content-Type: application/json").click();
  await page.keyboard.press("End");
  await page.keyboard.type("; charset=utf-8");
  // The file reads as edited, in the file view's tab and the request's.
  await expect(tab(page, "pets.http").locator(".dot")).toBeVisible();
  await expect(tab(page, "Create pet").locator(".dot")).toBeVisible();

  await tab(page, "Create pet").click();
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await expect.poll(() => headerRows(page)).toEqual(["Content-Type: application/json; charset=utf-8"]);

  // And back: an edit in the request's tab shows in the file view.
  await page.locator(".kv-row .c-name").first().fill("X-Content-Type");
  await tab(page, "pets.http").click();
  await expect(line(page, "X-Content-Type: application/json; charset=utf-8")).toBeVisible();
});

test("a request folds, and so does a body", async ({ page }) => {
  await openApp(page);
  await treeItem(page, "api").click();
  await treeMenu(page, "pets.http", "View as text");
  await expect(activeTab(page)).toContainText("pets.http");

  // The fold gutter's marker beside `### List pets`.
  const listY = (await line(page, "### List pets").boundingBox())!.y;
  const markers = fileView(page).locator('.cm-foldGutter span[title="Fold line"]');
  const tops = await markers.evaluateAll((els) => els.map((el) => el.closest(".cm-gutterElement")!.getBoundingClientRect().top));
  const index = tops.findIndex((top) => Math.abs(top - listY) < 4);
  expect(index).toBeGreaterThanOrEqual(0);
  await markers.nth(index).click();
  await expect(fileView(page).locator(".cm-foldPlaceholder")).toHaveCount(1);
  await expect(line(page, "GET {{baseUrl}}/pets?limit=20")).toHaveCount(0);
  await expect(line(page, "### Create pet")).toBeVisible();

  // The JSON body of Create pet folds from its first line.
  await line(page, '"name": "Rex"').click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Meta+Alt+[");
  await expect(fileView(page).locator(".cm-foldPlaceholder")).toHaveCount(2);
  await expect(line(page, '"name": "Rex"')).toHaveCount(0);
});

test("the Request menu opens the active request's file as text, and the tab comes back after a restart", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await menuClick(page, "view-file-as-text");
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(line(page, "### Create pet")).toBeVisible();
  // Saved with the Layout once it settles.
  await expect.poll(async () => (await mockState(page, "layouts"))["/demo"]).toMatchObject({ active: 1, tabs: [{ name: "List pets" }, { kind: "file", path: "api/pets.http" }] });

  await page.reload();
  await expect(treeItem(page, "api")).toBeVisible();
  await expect(activeTab(page)).toContainText("pets.http");
  await expect(line(page, "### Create pet")).toBeVisible();
  await expect(tab(page, "List pets")).toBeVisible();
});
