// Live bytes received while a body downloads (#67). `?download=slow` makes the
// mock send take ~2 s, emitting `send-progress` events as the body "arrives".
import { expect, test } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test("a downloading body shows an updating byte count next to the loading state", async ({ page }) => {
  await openApp(page, "?download=slow");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  const received = page.locator(".statusbar .loading .received");
  await expect(received).toHaveText(/^\d+(\.\d+)? (B|KB|MB) received$/);
  const first = await received.textContent();
  await expect(received).not.toHaveText(first!);

  // The count goes away once the response is in.
  await expect(page.locator(".statusbar .metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
  await expect(received).toHaveCount(0);
});

test("a send with nothing received yet shows no byte count", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await expect(page.locator(".statusbar .loading")).toBeVisible();
  await expect(page.locator(".statusbar .loading .received")).toHaveCount(0);
});
