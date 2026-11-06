import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp } from "./helpers";

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+Comma");
  return dialog(page, "Settings");
}

/** The settings the mocked backend last saved. */
async function savedSettings(page: Page) {
  return page.evaluate(() => (window as unknown as { __mock: { settings: { exec: Record<string, unknown> } } }).__mock.settings);
}

test("toggling Follow redirects applies at once and is still applied after reopening Settings", async ({ page }) => {
  await openApp(page);
  let settings = await openSettings(page);
  const follow = () => settings.locator(".setting", { hasText: "Follow redirects" }).getByRole("switch");
  await expect(follow()).toHaveAttribute("aria-checked", "true");

  await follow().click();
  await expect(follow()).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await savedSettings(page)).exec.followRedirects).toBe(false);

  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings).toHaveCount(0);
  settings = await openSettings(page);
  await expect(follow()).toHaveAttribute("aria-checked", "false");
});

test("the Settings footer has only a Done button", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  await expect(settings.locator("footer").getByRole("button")).toHaveText(["Done"]);
});
