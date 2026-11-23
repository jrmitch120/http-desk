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
/** The outline's row for the request labelled `label`. */
const row = (page: Page, label: string) => outline(page).getByRole("listitem").filter({ hasText: label });

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
  await expect(outline(page).getByRole("listitem")).toHaveText([
    /Get request with a header/,
    /Post with JSON body/,
    /Multi-line query/,
    /Basic auth/,
    new RegExp(FORM),
  ]);
  await expect(line(page, `### ${FORM}`)).not.toBeInViewport();

  await row(page, FORM).click();
  await expect(line(page, `### ${FORM}`)).toBeInViewport();
  await expect(row(page, FORM)).toHaveAttribute("aria-current", "true");
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
  await expect(row(page, "Multi-line query")).toHaveAttribute("aria-current", "true");
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

test("after clicking an outline row, focus stays in the outline and Down moves to the next row", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");

  await row(page, "Multi-line query").click();
  await expect(row(page, "Multi-line query")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Basic auth")).toBeFocused();
});

test("Up/Down/Home/End move through the outline and stop at its ends", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await row(page, "Post with JSON body").click();

  await page.keyboard.press("End");
  await expect(row(page, FORM)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, FORM)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Basic auth")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row(page, "Get request with a header")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Get request with a header")).toBeFocused();
  // Moving focus isn't choosing: the cursor stays in the request clicked.
  await expect(row(page, "Post with JSON body")).toHaveAttribute("aria-current", "true");
});

test("Enter on an outline row puts the text cursor at that request, with the text focused", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await row(page, "Get request with a header").click();
  await page.keyboard.press("End");

  await page.keyboard.press("Enter");
  await expect(fileView(page).locator(".cm-content")).toBeFocused();
  await expect(line(page, `### ${FORM}`)).toBeInViewport();
  await expect(row(page, FORM)).toHaveAttribute("aria-current", "true");
  // Typing goes in at the request.
  await page.keyboard.type("X");
  await expect(line(page, `X### ${FORM}`)).toBeVisible();
});

test("a double-click on an outline row puts the text cursor at that request, with the text focused", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");

  await row(page, FORM).dblclick();
  await expect(fileView(page).locator(".cm-content")).toBeFocused();
  await expect(row(page, FORM)).toHaveAttribute("aria-current", "true");
  await page.keyboard.type("X");
  await expect(line(page, `X### ${FORM}`)).toBeVisible();
});

test("the outline is one Tab stop: the request under the text cursor, else the row last focused", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  // The Request button is the stop before the outline; the text is the one after.
  const before = page.locator(".file-view .crumbs").getByRole("button", { name: "Request" });
  await line(page, "GET {{host}}/basic-auth/user/passwd").click();
  await expect(row(page, "Basic auth")).toHaveAttribute("aria-current", "true");

  // Into the outline: the row under the cursor.
  await before.focus();
  await page.keyboard.press("Tab");
  await expect(row(page, "Basic auth")).toBeFocused();
  // Out of it in one Tab either way, and back to the row last focused.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+Tab");
  await expect(before).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row(page, "Multi-line query")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(fileView(page).locator(".cm-content")).toBeFocused();

  // The cursor moved since: the stop follows it.
  await line(page, `### ${FORM}`).click();
  await expect(row(page, FORM)).toHaveAttribute("aria-current", "true");
  await before.focus();
  await page.keyboard.press("Tab");
  await expect(row(page, FORM)).toBeFocused();
});

test("⌘Enter right after clicking an outline row sends the request clicked", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await row(page, "Basic auth").click();

  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.url)).toEqual(["{{host}}/basic-auth/user/passwd"]);
  await expect(activeTab(page)).toContainText("Basic auth");
});

test("⌘Enter on an outline row is the app's: it sends the request under the cursor", async ({ page }) => {
  await openAsText(page, "samples", "jetbrains.http");
  await row(page, "Basic auth").click();
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await sentRequests(page)).map((r) => r.url)).toEqual(["{{host}}/basic-auth/user/passwd"]);
  await expect(activeTab(page)).toContainText("Basic auth");
});
