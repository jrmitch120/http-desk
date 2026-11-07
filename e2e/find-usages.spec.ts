// Find usages (#84): a hover card's Find usages lists, in the sidebar, every place
// in the workspace that references the variable (requests, File variables,
// environment values), marks the ones that aren't sent, and opens each on the
// field that holds it.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, urlBar } from "./helpers";

const card = (page: Page) => page.locator(".popup-layer .var-card");
const usages = (page: Page) => page.getByRole("region", { name: /^Usages of / });
/** Each listed place as "title | where". */
const rows = (page: Page) =>
  usages(page)
    .locator(".usage")
    .evaluateAll((els) => els.map((el) => [...el.querySelectorAll(".hit-text > *")].map((s) => s.textContent!.trim()).join(" | ")));

/** Hovers `{{name}}` in `field` and clicks Find usages in its card. */
async function findUsages(page: Page, field: Locator, name: string): Promise<void> {
  await field.locator(".cm-var", { hasText: `{{${name}}}` }).first().hover();
  await card(page).getByRole("button", { name: "Find usages" }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(usages(page)).toBeVisible();
}

test("Find usages lists every request that uses a variable and opens the one clicked", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  await findUsages(page, page.locator(".url-input"), "baseUrl");

  await expect(usages(page)).toContainText("Usages of {{baseUrl}}");
  await expect.poll(() => rows(page)).toEqual([
    "List pets | pets.http · URL",
    "Create pet | pets.http · URL",
    "Get pet image | pets.http · URL",
  ]);
  await usages(page).locator(".usage", { hasText: "Get pet image" }).click();
  await expect(page.locator(".tab.active")).toContainText("Get pet image");
  await expect(urlBar(page)).toBeFocused();
  // The list stays until closed.
  await usages(page).getByRole("button", { name: "Close usages" }).click();
  await expect(usages(page)).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Explorer" })).toBeVisible();
});

test("unsaved edits are searched, a disabled header is marked, and clicking shows its row", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  // X-Debug, the second header, is disabled; give it {{petId}} without saving.
  const row = page.locator(".kv-row").nth(1);
  await expect(row.locator("input.c-name")).toHaveValue("X-Debug");
  const value = row.locator(".c-value");
  await value.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{petId}}");
  await page.keyboard.press("Tab");

  await findUsages(page, value, "petId");

  await expect.poll(() => rows(page)).toEqual([
    "List pets | pets.http · Header X-Debug · disabled",
    "Get pet image | pets.http · URL",
  ]);
  await page.locator(".subtab", { hasText: "Params" }).click();
  await usages(page).locator(".usage", { hasText: "Header X-Debug" }).click();
  await expect(page.locator(".subtab.active")).toContainText("Headers");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".kv-row")?.querySelector<HTMLInputElement>(".c-name")?.value)).toBe("X-Debug");
});

test("references inside environment values are listed and open the variable's row", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  const dialog = page.getByRole("dialog", { name: "Environments" });
  await dialog.locator(".env").filter({ has: page.getByText("staging", { exact: true }) }).click();
  const grid = dialog.getByRole("group", { name: "Variables" });
  await grid.getByPlaceholder("Add variable").click();
  await page.keyboard.type("api");
  await page.keyboard.press("Tab");
  await page.keyboard.type("{{baseUrl}}/v1");
  await page.keyboard.press("Tab");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await openRequest(page, ["api", "pets.http"], "List pets");
  await findUsages(page, page.locator(".url-input"), "baseUrl");
  await expect.poll(() => rows(page)).toContain('api | Environment "staging"');

  await usages(page).locator(".usage", { hasText: 'Environment "staging"' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".main-head .title")).toHaveText("staging");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".kv-row")?.querySelector<HTMLInputElement>(".c-name")?.value)).toBe("api");
});
