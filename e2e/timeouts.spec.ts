import { expect, test } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test("Request Settings label the per-request idle and connection timeouts", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Settings" }).click();

  await expect(page.getByRole("textbox", { name: "Idle timeout" })).toBeVisible();
  await expect(page.getByText("Saved as # @timeout")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Connection timeout" })).toBeVisible();
  await expect(page.getByText("Saved as # @connection-timeout")).toBeVisible();
});

test("app Settings label the default idle and connection timeouts", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");

  await expect(page.locator(".setting .label > span", { hasText: /^Idle timeout$/ })).toBeVisible();
  await expect(page.locator(".setting .label > span", { hasText: /^Connection timeout$/ })).toBeVisible();
});

test("the two timeout fields are the same width, however their hints wrap", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Settings" }).click();
  for (const width of [1000, 1400, 1800]) {
    await page.setViewportSize({ width, height: 800 });
    const idle = await page.getByRole("textbox", { name: "Idle timeout" }).boundingBox();
    const connect = await page.getByRole("textbox", { name: "Connection timeout" }).boundingBox();
    expect(connect!.width, `at ${width}px`).toBe(idle!.width);
    expect(idle!.width, `at ${width}px`).toBe(110);
  }
});
