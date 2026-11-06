// The Environments editor warns when git doesn't ignore the private env file.
// The mocked `local` environment has a Secret (`token`).
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

const warning = /http-client\.private\.env\.json is not ignored by git/;

test("warns when the private env file is not ignored by git", async ({ page }) => {
  await openApp(page, "?privateFileIgnored=false");
  await page.getByTitle(/Manage environments/).click();
  await expect(page.getByText(warning)).toBeVisible();
});

test("shows no warning when the private env file is ignored", async ({ page }) => {
  await openApp(page);
  await page.getByTitle(/Manage environments/).click();
  await expect(page.getByPlaceholder("Filter variables")).toBeVisible();
  await expect(page.getByText(warning)).toHaveCount(0);
});
