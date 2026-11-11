// Transferred size and content encoding (#66). `?response=gzip` makes the mock
// answer with the pets JSON gzip-encoded: 112 bytes on the wire, 144 decoded.
import { expect, test } from "@playwright/test";
import { clipboard, mockState, openApp, openRequest } from "./helpers";

test("the size tooltip shows transferred size, decoded size and encoding", async ({ page }) => {
  await openApp(page, "?response=gzip");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await page.locator(".metric", { hasText: "Size" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Transferred 112 B (gzip) · Decoded 144 B · Headers 120 B");
});

test("an unencoded response's size tooltip shows the body and headers", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await page.locator(".metric", { hasText: "Size" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Body 144 B · Headers 120 B");
});

test("the Request tab lists the Accept-Encoding that was sent", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: /^Request\b/ }).click();
  await expect(page.getByRole("row", { name: /Accept-Encoding/ })).toContainText("gzip, deflate, br, zstd");
});

// `?response=asReceived`: a JSON content type, but the Content-Encoding couldn't be
// undone, so the core says the body is binary (its bytes happen to read as JSON).
test("a body kept as received is binary whatever its content type says: Hex, no filter, copied as base64", async ({ page }) => {
  await openApp(page, "?response=asReceived");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await expect(page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio")).toHaveText(["Hex"]);
  await expect(page.locator(".body .cm-content")).toContainText("00000000  7b 22 73 74");
  await expect(page.getByRole("combobox", { name: "Filter with JSONPath" })).toHaveCount(0);
  expect((await mockState(page, "bodyRequests")).filter((r) => r.view !== "bytes")).toEqual([]);

  await page.getByRole("button", { name: "Copy body" }).click();
  await expect(page.getByText("Response body copied as base64")).toBeVisible();
  expect(await clipboard(page)).toBe(btoa('{"still":"compressed"}'));
});
