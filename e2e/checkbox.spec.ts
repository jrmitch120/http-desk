// The owned Checkbox (ADR 0002): key/value rows, "enable all", the file body's
// "substitute variables" option and the OpenAPI importer's selections.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests } from "./helpers";

// List pets has two headers: Accept (on) and X-Debug (off).
async function openHeaders(page: Page): Promise<void> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();
}

async function sentHeaders(page: Page): Promise<{ name: string; enabled: boolean }[]> {
  const sent = (await sentRequests(page)) as unknown as { headers: { items: { name: string; enabled: boolean }[] } }[];
  return sent.at(-1)!.headers.items.map(({ name, enabled }) => ({ name, enabled }));
}

test("a header's checkbox enables and disables it", async ({ page }) => {
  await openHeaders(page);
  const accept = page.getByRole("checkbox", { name: "Enable Accept" });
  const debug = page.getByRole("checkbox", { name: "Enable X-Debug" });
  await expect(accept).toHaveAttribute("aria-checked", "true");
  await expect(debug).toHaveAttribute("aria-checked", "false");

  await accept.click();
  await debug.click();
  await expect(accept).toHaveAttribute("aria-checked", "false");
  await expect(debug).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("200 OK")).toBeVisible();
  expect(await sentHeaders(page)).toEqual([
    { name: "Accept", enabled: false },
    { name: "X-Debug", enabled: true },
  ]);
});

test('"enable all" shows the mixed state when some rows are off, and clicking it enables all', async ({ page }) => {
  await openHeaders(page);
  const all = page.getByRole("checkbox", { name: "Enable all" });
  await expect(all).toHaveAttribute("aria-checked", "mixed");

  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: "Enable X-Debug" })).toHaveAttribute("aria-checked", "true");

  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: "Enable Accept" })).toHaveAttribute("aria-checked", "false");

  await page.getByRole("checkbox", { name: "Enable Accept" }).click();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
});

test("Space toggles a focused checkbox and Enter leaves it alone", async ({ page }) => {
  await openHeaders(page);
  const debug = page.getByRole("checkbox", { name: "Enable X-Debug" });
  await debug.focus();

  await page.keyboard.press("Space");
  await expect(debug).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(debug).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Space");
  await expect(debug).toHaveAttribute("aria-checked", "false");
  await expect(debug).toBeFocused();
});

test("a focused checkbox shows the focus ring", async ({ page }) => {
  await openHeaders(page);
  // The row's checkbox comes just before its name cell in tab order.
  await page.locator(".kv-row input.c-name").first().focus();
  await page.keyboard.press("Shift+Tab");
  const accept = page.getByRole("checkbox", { name: "Enable Accept" });
  await expect(accept).toBeFocused();
  const box = accept.locator(".box");
  await expect(box).toHaveCSS("outline-style", "solid");
  await expect(box).toHaveCSS("outline-width", "2px");
});
