// A tooltip in a text editor is as wide as its message (up to its limit) in WebKit,
// the app's webview on macOS and Linux. WebKit lays CodeMirror's tooltips out
// absolutely in the popup layer, which has no width, so one not sized by its own
// content breaks after every word. Chromium never did, hence the WebKit project.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, openApp, treeItem, treeMenu } from "../helpers";

const code = (page: Page) => page.locator(".file-view .file-code");

async function openAsText(page: Page) {
  await openApp(page);
  await treeItem(page, "api").click();
  await treeMenu(page, "pets.http", "View file as text");
  await expect(activeTab(page)).toContainText("pets.http");
}

/** The tooltip's width and how many lines its text takes. */
async function shape(tip: ReturnType<Page["locator"]>) {
  return tip.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
    return { width: el.getBoundingClientRect().width, lines: lines.size };
  });
}

test("a problem's message, shown from the keyboard or by hovering, isn't a word per line", async ({ page }) => {
  await openAsText(page);
  await code(page).locator(".cm-line", { hasText: "POST {{baseUrl}}/pets" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(code(page).locator(".cm-underline-error")).not.toHaveCount(0);

  await code(page).locator(".cm-line", { hasText: "@petId = 1" }).click();
  await page.keyboard.press("F8");
  const tip = page.locator(".cm-underline-tip");
  await expect(tip).toContainText("Error:");
  const shown = await shape(tip);
  // A sentence of some twenty words: a few lines at up to 360px, not one per word.
  expect(shown.width).toBeGreaterThan(200);
  expect(shown.width).toBeLessThanOrEqual(360);
  expect(shown.lines).toBeLessThanOrEqual(5);

  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await code(page).locator(".cm-underline-error").first().hover();
  await expect(tip).toContainText("Error:");
  expect((await shape(tip)).width).toBeGreaterThan(200);
});

test("a gutter marker's hover, the app's own tooltip, isn't either", async ({ page }) => {
  await openApp(page, "?portability=vscode,rider");
  await treeItem(page, "samples").click();
  await treeMenu(page, "jetbrains.http", "View file as text");
  const marker = code(page).locator(".cm-line-mark").first();
  await expect(marker).toBeVisible();
  await page.mouse.move(0, 0);
  await marker.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const shown = await shape(tip);
  expect(shown.width).toBeGreaterThan(200);
  expect(shown.lines).toBeLessThanOrEqual(3);
});
