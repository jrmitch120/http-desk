// The file view scrolls like any editor in WebKit, the app's webview on macOS
// and Linux: the wheel moves the text and stays where it was moved, and the
// arrow keys keep the cursor's line in view. With `contain: strict` on the
// editor's box, WebKit could lay the editor out at its full content height, so
// the box clipped the text and neither could scroll it. Chromium never did,
// hence a WebKit project (`pnpm test:webkit`).
import { expect, test, type Page } from "@playwright/test";
import { activeTab, openApp, treeItem, treeMenu } from "../helpers";

const code = (page: Page) => page.locator(".file-view .file-code");

/** Opens samples/jetbrains.http as text in a window short enough for it to scroll; the text of `replaceWith` (a file the dev server serves) replaces its contents. */
async function openAsText(page: Page, replaceWith?: string) {
  const text = replaceWith && (await (await page.request.get(replaceWith)).text());
  if (text) expect(text).toMatch(/^### |^# /m);
  await page.setViewportSize({ width: 1200, height: 560 });
  await openApp(page);
  await treeItem(page, "samples").click();
  await treeItem(page, "jetbrains.http").click();
  await treeMenu(page, "jetbrains.http", "View file as text");
  await expect(activeTab(page)).toContainText("jetbrains.http");
  await code(page).locator(".cm-line").first().click();
  if (text) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await page.keyboard.press("ControlOrMeta+Home");
  }
}

/** The editor's scroll position, and whether the cursor's line is inside the box. */
const view = (page: Page) =>
  code(page).evaluate((box) => {
    const b = box.getBoundingClientRect();
    const line = box.querySelector(".cm-activeLine")?.getBoundingClientRect();
    return { scrollTop: box.querySelector(".cm-scroller")!.scrollTop, cursorInView: !!line && line.top >= b.top - 1 && line.bottom <= b.bottom + 1 };
  });

// The demo workspace's chaining.http: handlers, variables and marks, a longer file.
const files: Record<string, string | undefined> = { "jetbrains.http": undefined, "chaining.http": "/examples/demo/api/chaining.http" };

for (const [name, text] of Object.entries(files)) {
  test(`${name}: the wheel scrolls the text, and it stays scrolled`, async ({ page }) => {
    await openAsText(page, text);
    const box = (await code(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tops: number[] = [];
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(250); // longer than the outline's and explorer's 120 ms follow delay
      tops.push((await view(page)).scrollTop);
    }
    expect(tops.every((t, i) => t > (tops[i - 1] ?? 0)), `scroll positions ${tops}`).toBe(true);
  });

  test(`${name}: the arrow keys keep the cursor's line in view`, async ({ page }) => {
    await openAsText(page, text);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const v = await view(page);
      expect(v.cursorInView, `after ${i + 1} × ArrowDown`).toBe(true);
    }
    expect((await view(page)).scrollTop).toBeGreaterThan(0);
    await expect(code(page).locator(".cm-content")).toBeFocused();
  });
}
