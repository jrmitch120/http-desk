// A failed send says what went wrong (classified by the core) and offers Retry.
// The mocked backend fails every send with `?sendError=<kind>`.
import { expect, test } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

test("a DNS failure names the host, hints at the URL or environment, and Retry sends again", async ({ page }) => {
  await openApp(page, "?sendError=dns");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  const panel = page.getByRole("alert").filter({ hasText: "Host not found" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Couldn't find host api.exmaple.com. Check the URL or the selected environment.");
  await expect(panel).not.toContainText("that the server is reachable");
  expect(await sentRequests(page)).toHaveLength(1);

  await panel.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => sentRequests(page).then((s) => s.length)).toBe(2);
  await expect(page.getByRole("alert").filter({ hasText: "Host not found" })).toBeVisible();
});

test("an unclassified failure keeps the general hint", async ({ page }) => {
  await openApp(page, "?sendError=other");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");

  const panel = page.getByRole("alert").filter({ hasText: "Could not send request" });
  await expect(panel).toContainText("Check the URL, the selected environment, and that the server is reachable.");
  await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
});
