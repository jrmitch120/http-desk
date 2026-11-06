// Transferred size and content encoding (#66). `?response=gzip` makes the mock
// answer with the pets JSON gzip-encoded: 112 bytes on the wire, 144 decoded.
import { expect, test } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test("the size tooltip shows transferred size, decoded size and encoding", async ({ page }) => {
  await openApp(page, "?response=gzip");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  await page.locator(".metric", { hasText: "Size" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Transferred 112 B (gzip) · Decoded 144 B · Headers 120 B");
});

test("an unencoded response's size tooltip shows the body and headers", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  await page.locator(".metric", { hasText: "Size" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Body 144 B · Headers 120 B");
});

test("the Request tab lists the Accept-Encoding that was sent", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  await page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: /^Request\b/ }).click();
  await expect(page.locator(".table-wrap tr", { hasText: "Accept-Encoding" })).toContainText("gzip, deflate, br, zstd");
});
