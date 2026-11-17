// History (#153, ADR-0009): a recorded request never holds a Secret's value or a
// prompt answer; each is masked wherever it shows. `?asSent=1` makes the mock's
// response carry the request as sent (resolved, values in clear) as the shell's does,
// and `?prompts=otp` declares a Prompt variable on List pets (`local` selected, whose
// `token` is a Secret).
import { expect, test } from "@playwright/test";
import { dialog, openApp, openRequest, urlBar } from "./helpers";

test("an entry's Request view shows a Secret's value and a prompt answer masked", async ({ page }) => {
  await openApp(page, "?prompts=otp&asSent=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&key={{token}}&code={{otp}}");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const form = dialog(page, 'Value for "otp"');
  await form.getByLabel("otp", { exact: true }).fill("842913");
  await form.getByLabel("otp", { exact: true }).press("Enter");
  await expect(form).toBeHidden();

  // The live response shows the request as it went out.
  const live = page.locator(".statusbar").first();
  await expect(live.locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
  await page.getByRole("radio", { name: "Request" }).click();
  await expect(page.locator(".sent-line")).toContainText("key=dev-token-123&code=842913");

  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("list", { name: "History entries" }).getByRole("listitem").first().getByRole("button").click();
  const entry = page.getByRole("region", { name: "History entry" });
  await entry.getByRole("radio", { name: "Request" }).click();

  await expect(entry.locator(".sent-line")).toHaveText("GET http://127.0.0.1:8765/pets?limit=20&key=••••••••&code=••••••••");
  await expect(entry.getByText("dev-token-123")).toHaveCount(0);
  await expect(entry.getByText("842913")).toHaveCount(0);
});
