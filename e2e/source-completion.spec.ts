// Completion while typing in a request's .http source (#169): header names on a
// header line, variables inside `{{`, directives after `# @`. What's offered
// where is unit-tested in src/lib/codemirror/httpCompletion.test.ts.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const toggle = (page: Page) => page.getByRole("button", { name: ".http", exact: true });
const source = (page: Page) => page.locator(".source-code");
const list = (page: Page) => page.locator(".popup-layer .cm-tooltip-autocomplete");

/** Opens List pets (the `local` environment is selected: baseUrl, Secret token) in its source, the caret at the end of the line `line`. */
async function openSourceAt(page: Page, line: string): Promise<void> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await toggle(page).click();
  await source(page).locator(".cm-line", { hasText: line }).first().click();
  await page.keyboard.press("End");
}

/**
 * Accepts `option` once it's selected. CodeMirror leaves Enter alone for 75 ms
 * after the list changes, and in the source an Enter it leaves alone breaks the line,
 * so this waits that out rather than retrying.
 */
async function accept(page: Page, option: string): Promise<void> {
  await expect(list(page).locator("li[aria-selected]")).toHaveText(new RegExp(`^${option}`));
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeHidden();
}

test("typing Con on a header line offers Content-Type, and Enter writes it", async ({ page }) => {
  await openSourceAt(page, "Accept: application/json");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Con");

  await expect(list(page)).toBeVisible();
  await expect(list(page).getByRole("option", { name: "Content-Type" })).toBeVisible();
  await page.keyboard.type("t");
  await accept(page, "Content-Type");
  // With its colon, the caret after it for the value.
  await expect(source(page).locator(".cm-activeLine")).toHaveText("Content-Type: ");
});

test("typing {{ offers a variable from the selected environment", async ({ page }) => {
  await openSourceAt(page, "Accept: application/json");
  await page.keyboard.press("Enter");
  await page.keyboard.type("X-Base: {{");

  await expect(list(page)).toBeVisible();
  await expect(list(page).getByRole("option", { name: /^baseUrl/ })).toBeVisible();
  await page.keyboard.type("bas");
  await accept(page, "baseUrl");
  await expect(source(page).locator(".cm-activeLine")).toHaveText("X-Base: {{baseUrl}}");
});

test("typing # @ offers the directives, name among them", async ({ page }) => {
  await openSourceAt(page, "### List pets");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# @");

  await expect(list(page)).toBeVisible();
  await expect(list(page).getByRole("option", { name: "name", exact: true })).toBeVisible();
  await page.keyboard.type("na");
  await accept(page, "name");
  await expect(source(page).locator(".cm-activeLine")).toHaveText("# @name");
});

test("nothing is offered in a body", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await toggle(page).click();
  await source(page).locator(".cm-line", { hasText: '"name": "Rex"' }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Cont");

  await expect(source(page).locator(".cm-activeLine")).toContainText("Cont");
  // Long enough for the list to have opened (CodeMirror waits 100 ms after typing).
  await page.waitForTimeout(300);
  await expect(list(page)).toBeHidden();
});
