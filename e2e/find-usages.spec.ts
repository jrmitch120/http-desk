// Find usages (#84): a hover card's Find usages lists, in the sidebar, every place
// in the workspace that references the variable (requests, File variables,
// environment values), marks the ones that aren't sent, and opens each on the
// field that holds it. A row of the Environments matrix offers it too.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, showEnvironmentList, showEnvironmentMatrix, urlBar } from "./helpers";

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

/** The matrix's value field of `name` in `column` ("Shared" or an environment). */
const matrixField = (page: Page, name: string, column: string) => page.getByRole("textbox", { name: `${name} in ${column}`, exact: true });

test("references inside environment values are listed and open the variable's cell, or row in the list", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  const modal = dialog(page, "Environments");
  await showEnvironmentMatrix(page);
  // staging has no token: fill its gap with a reference to baseUrl.
  await matrixField(page, "token", "staging").click();
  await page.keyboard.type("{{baseUrl}}/v1");
  await page.keyboard.press("Tab");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toHaveCount(0);

  await openRequest(page, ["api", "pets.http"], "List pets");
  await findUsages(page, page.locator(".url-input"), "baseUrl");
  await expect.poll(() => rows(page)).toContain('token | Environment "staging"');

  // The matrix (picked above, so remembered) focuses the variable's cell in that environment.
  const result = usages(page).locator(".usage", { hasText: 'Environment "staging"' });
  await result.click();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("group", { name: "Environments matrix" })).toBeVisible();
  await expect(matrixField(page, "token", "staging")).toBeFocused();

  // The list shows that environment and focuses the variable's row.
  await showEnvironmentList(page);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await result.click();
  await expect(modal).toBeVisible();
  await expect(modal.locator(".main-head .title")).toHaveText("staging");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".kv-row")?.querySelector<HTMLInputElement>(".c-name")?.value)).toBe("token");
});

test("a matrix row's Find usages closes the Environments modal and lists the variable's usages", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  const modal = dialog(page, "Environments");
  await showEnvironmentMatrix(page);
  const matrix = modal.getByRole("group", { name: "Environments matrix" });

  // From the name's context menu.
  await matrix.locator(".m-name", { hasText: "baseUrl" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Find usages", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(usages(page)).toContainText("Usages of {{baseUrl}}");
  await expect.poll(() => rows(page)).toEqual([
    "List pets | pets.http · URL",
    "Create pet | pets.http · URL",
    "Get pet image | pets.http · URL",
  ]);

  // From the row's Actions button, with an unsaved edit: Cancel keeps the modal (and the edit).
  await page.getByRole("button", { name: "Manage environments" }).click();
  await matrixField(page, "token", "staging").click();
  await page.keyboard.type("x");
  await page.keyboard.press("Tab");
  await matrix.locator(".kv-row").filter({ hasText: "token" }).getByRole("button", { name: "Actions for token" }).click();
  await page.getByRole("menuitem", { name: "Find usages", exact: true }).click();
  const discard = dialog(page, "Discard changes?");
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeVisible();
  await expect(matrixField(page, "token", "staging")).toHaveText("x");
  await expect(usages(page)).toContainText("Usages of {{baseUrl}}");

  // Discard closes it and searches.
  await matrix.locator(".kv-row").filter({ hasText: "token" }).getByRole("button", { name: "Actions for token" }).click();
  await page.getByRole("menuitem", { name: "Find usages", exact: true }).click();
  await dialog(page, "Discard changes?").getByRole("button", { name: "Discard" }).click();
  await expect(modal).toHaveCount(0);
  await expect(usages(page)).toContainText("Usages of {{token}}");
});
