// Getting around a file view and sending from it (#167): an outline of its requests
// beside the text, the explorer selecting the request under the cursor and the file
// view following the explorer, and ⌘Enter sending the request under the cursor the
// way its own tab sends it.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, openApp, sentRequests, tab, treeItem, treeMenu } from "./helpers";

const fileView = (page: Page) => page.locator(".file-view .file-code");
const line = (page: Page, text: string) => fileView(page).locator(".cm-line", { hasText: text });
const outline = (page: Page) => page.getByRole("navigation", { name: "Outline" });
const FORM = "Send a form with the text and file fields";

/** Opens `file` (in `folder`) as text, its requests shown in the explorer, in a window short enough for it to scroll. */
async function openAsText(page: Page, folder: string, file: string) {
  await page.setViewportSize({ width: 1200, height: 560 });
  await openApp(page);
  await treeItem(page, folder).click();
  await treeItem(page, file).click();
  await treeMenu(page, file, "View file as text");
  await expect(activeTab(page)).toContainText(file);
  await expect(fileView(page).locator(".cm-line").first()).toBeVisible();
}

test("⌘Enter in the file view sends the request under the cursor, from its own tab", async ({ page }) => {
  await openAsText(page, "api", "pets.http");

  await line(page, '"name": "Rex"').click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.method)).toEqual(["POST"]);
  // Its response shows where a send from its tab shows it: in that tab, now active.
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(page.locator(".response").getByText(/^\d{3} /).first()).toBeVisible();
  // The text wasn't touched (no blank line inserted).
  await tab(page, "pets.http").click();
  await expect(tab(page, "pets.http").locator(".dot")).toHaveCount(0);

  await line(page, "### Get pet image").click();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await sentRequests(page)).map((r) => `${r.method} ${r.url}`)).toEqual(["POST {{baseUrl}}/pets", "GET {{baseUrl}}/png/{{petId}}"]);
  await expect(activeTab(page)).toContainText("Get pet image");
});

test("clicking an outline entry scrolls the file view to it", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await expect(outline(page).getByRole("button")).toHaveText([
    /Get request with a header/,
    /Post with JSON body/,
    /Multi-line query/,
    /Basic auth/,
    new RegExp(FORM),
  ]);
  await expect(line(page, `### ${FORM}`)).not.toBeInViewport();

  await outline(page).getByRole("button", { name: FORM }).click();
  await expect(line(page, `### ${FORM}`)).toBeInViewport();
  await expect(outline(page).getByRole("button", { name: FORM })).toHaveAttribute("aria-current", "true");
});

test("moving the cursor selects the request it's in, in the explorer", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");

  await line(page, "GET {{host}}/basic-auth/user/passwd").click();
  await expect(treeItem(page, "Basic auth")).toHaveAttribute("aria-selected", "true");
  await expect(treeItem(page, "Multi-line query")).toHaveAttribute("aria-selected", "false");

  // Up into the request above: its last line, then its request line.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(treeItem(page, "Multi-line query")).toHaveAttribute("aria-selected", "true");
  await expect(treeItem(page, "Basic auth")).toHaveAttribute("aria-selected", "false");
  await expect(outline(page).getByRole("button", { name: "Multi-line query" })).toHaveAttribute("aria-current", "true");
});

test("selecting a request in the explorer scrolls the file view to it", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await expect(line(page, `### ${FORM}`)).not.toBeInViewport();

  await treeItem(page, FORM).click();
  // The file view stays, scrolled to the request.
  await expect(activeTab(page)).toContainText("jetbrains.http");
  await expect(line(page, `### ${FORM}`)).toBeInViewport();
  await expect(treeItem(page, FORM)).toHaveAttribute("aria-selected", "true");
});
