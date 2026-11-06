// Banners (warning, error, info) share one component: errors are announced as
// alerts, everything else as a status, and a severity looks the same wherever
// the banner appears.
import { expect, test, type Locator } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

/** The colours a banner's severity is read from. */
function tone(banner: Locator): Promise<{ color: string; background: string }> {
  return banner.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  });
}

test("a warning banner in Settings is exposed as a status", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator(".setting", { hasText: "Verify server certificates" }).getByRole("switch").click();

  await expect(page.getByRole("status").filter({ hasText: "Certificate verification is off" })).toBeVisible();
});

test("an error banner in the response viewer is exposed as an alert", async ({ page }) => {
  await openApp(page, "?sendError=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  const alert = page.getByRole("alert").filter({ hasText: "Could not send request" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Connection refused");
});

test("the OpenAPI importer's warnings banner is exposed as a status", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Import OpenAPI" }).first().click();
  await page.getByPlaceholder("/path/to/openapi.yaml").fill("/demo/openapi.yaml");
  await page.keyboard.press("Enter");

  const banner = page.getByRole("status").filter({ hasText: "1 warning while reading the specification" });
  await banner.getByRole("button").click();
  await expect(banner).toContainText("Unresolved external $ref");
});

test("warning banners look the same in the request editor, the Environments editor and Settings", async ({ page }) => {
  await openApp(page, "?privateFileIgnored=false");
  const status = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("switch", { name: "Enabled" }).click();
  const sectionOff = await tone(status("Query parameters disabled."));

  await page.locator(".subtab", { hasText: "Body" }).click();
  await page.locator(".code .cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("### Heading");
  const body = await tone(status("starts with ###"));

  await page.keyboard.press("ControlOrMeta+E");
  const envs = await tone(status(/http-client\.private\.env\.json is not ignored by git/));
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator(".setting", { hasText: "Verify server certificates" }).getByRole("switch").click();
  const settings = await tone(status("Certificate verification is off"));

  expect(envs).toEqual(settings);
  expect(body).toEqual(settings);
  expect(sectionOff).toEqual(settings);
});
