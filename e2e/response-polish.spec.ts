// Response viewer polish (#71): status explanations, per-tab word-wrap, and
// copying a binary body as base64.
import { expect, test, type Page } from "@playwright/test";
import { clipboard, dialog, mockState, openApp, openRequest, tab } from "./helpers";

async function send(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

/** Records clipboard writes instead of touching the real clipboard. */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void w.__copied.push(text), readText: async () => w.__copied.at(-1) ?? "" },
    });
  });
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("the status pill's tooltip explains a listed status code", async ({ page }) => {
  await openApp(page, "?status=422");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await page.locator(".statusbar .tip", { hasText: "422" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "422 Unprocessable Content: the server understood the request but the content was invalid",
  );
});

test("an unlisted status code's tooltip falls back to its class", async ({ page }) => {
  await openApp(page, "?status=499");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await page.locator(".statusbar .tip", { hasText: "499" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("4xx client error");
});

test("word-wrap is remembered per tab and survives switching tabs", async ({ page }) => {
  await openApp(page);
  const wrapButton = page.getByRole("button", { name: "Wrap lines" });
  const wrapped = page.locator(".body .cm-editor .cm-lineWrapping");

  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await wrapButton.click();
  await expect(wrapButton).toHaveClass(/active/);
  await expect(wrapped).toHaveCount(1);

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await expect(wrapButton).not.toHaveClass(/active/);
  await expect(wrapped).toHaveCount(0);

  await tab(page, "List pets").click();
  await expect(wrapButton).toHaveClass(/active/);
  await expect(wrapped).toHaveCount(1);

  await tab(page, "Create pet").click();
  await expect(wrapButton).not.toHaveClass(/active/);
});

test("Copy body copies a text response through the shell, not the webview's clipboard", async ({ page }) => {
  await recordClipboard(page);
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await page.getByRole("button", { name: "Copy body" }).click();
  await expect(page.getByText("Response body copied", { exact: true })).toBeVisible();
  expect(await mockState(page, "bodyCopies")).toHaveLength(1);
  expect(await clipboard(page)).toContain('"name":"Rex"');
  expect(await copied(page)).toEqual([]);
});

test("Copy body copies a binary response as base64 through the shell", async ({ page }) => {
  await recordClipboard(page);
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await send(page);

  await page.getByRole("button", { name: "Copy body" }).click();
  await expect(page.getByText("Response body copied as base64")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await mockState(page, "bodyCopies")).toHaveLength(1);
  const text = await clipboard(page);
  expect(text.startsWith("iVBORw0KGgo")).toBe(true); // a PNG's signature, base64-encoded
  expect(atob(text).length).toBe(2749);
  expect(await copied(page)).toEqual([]);
});

test("Copy body asks before copying a large binary response as base64, then copies it through the shell", async ({ page }) => {
  await recordClipboard(page);
  await openApp(page, "?bigBinary=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await send(page);
  const copy = page.getByRole("button", { name: "Copy body" });
  const confirm = dialog(page, "Copy as base64?");

  await copy.click();
  await expect(confirm).toContainText("The body is 2.00 MB, which is 2.67 MB of text as base64.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await mockState(page, "bodyCopies")).toEqual([]);

  await copy.click();
  await confirm.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Response body copied as base64")).toBeVisible();
  expect(await mockState(page, "bodyCopies")).toHaveLength(1);
  expect(atob(await clipboard(page)).length).toBe(2 * 1024 * 1024);
  expect(await copied(page)).toEqual([]);
});

test("Copy body reports a clipboard that can't be written", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await page.evaluate(() => ((window as unknown as { __mock: { clipboardFails: boolean } }).__mock.clipboardFails = true));

  await page.getByRole("button", { name: "Copy body" }).click();
  await expect(page.getByText("The clipboard can't be written")).toBeVisible();
});
