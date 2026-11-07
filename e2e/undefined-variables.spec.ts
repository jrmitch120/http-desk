// Undefined-variable checks (#82): Undefined variables are underlined, counted on
// the section tabs and listed in a strip above the request's sections with quick
// fixes. The mocked workspace starts on `local` (baseUrl, Secret token); `staging`
// has only baseUrl. Create pet has a Content-Type header and a JSON body.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, sentRequests, showEnvironmentList } from "./helpers";

const strip = (page: Page) => page.getByRole("region", { name: "Pre-send checks" });
const subtab = (page: Page, name: string) => page.locator(".subtab", { hasText: name });
/** The Undefined-variable count on a section tab. */
const count = (page: Page, name: string) => subtab(page, name).locator(".undefined-count");

/** Opens Create pet's Headers and retypes the first header's value. */
async function headerValue(page: Page, text: string): Promise<Locator> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await subtab(page, "Headers").click();
  const cell = page.locator(".kv-row").first().locator(".c-value");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Tab");
  return cell;
}

async function selectEnvironment(page: Page, env: string): Promise<void> {
  await page.getByRole("combobox", { name: "Active environment" }).click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option", { name: env }).click();
}

/** The names in a grid's rows. */
const names = (grid: Locator) => grid.locator(".kv-row:not(.ghost) .c-name").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));

/** The focused element's grid row: its name and whether focus is in its value cell. */
const focusedRow = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      name: (el?.closest(".kv-row")?.querySelector(".c-name") as HTMLInputElement | null)?.value ?? null,
      inValue: !!el?.closest(".c-value"),
    };
  });

test("an Undefined header variable is underlined, counted on the Headers tab and listed in the strip", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await expect(strip(page)).toHaveCount(0);

  const cell = await headerValue(page, "{{apiKey}}-{{tenant}}");
  const marks = cell.locator(".cm-var-bad");
  await expect(marks).toHaveText(["{{apiKey}}", "{{tenant}}"]);
  expect(await marks.first().evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");

  await expect(count(page, "Headers")).toHaveText("2");
  await expect(count(page, "Params")).toHaveCount(0);
  await expect(strip(page).getByRole("listitem")).toHaveText([/apiKey.*used in Headers/, /tenant.*used in Headers/]);

  // The same name in another section is listed once, naming both.
  await subtab(page, "Body").click();
  await page.locator(".panel .cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" {{apiKey}}");
  await expect(count(page, "Body")).toHaveText("1");
  await expect(strip(page).getByRole("listitem")).toHaveText([/apiKey.*used in Headers and Body/, /tenant.*used in Headers/]);

  // Fixing it in place updates the counts and the strip as you type.
  await subtab(page, "Headers").click();
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("application/json");
  await expect(count(page, "Headers")).toHaveCount(0);
  await expect(strip(page).getByRole("listitem")).toHaveText([/apiKey.*used in Body/]);
});

test("the strip never blocks sending", async ({ page }) => {
  await headerValue(page, "{{apiKey}}");
  await expect(strip(page)).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(1);
  await expect(strip(page)).toBeVisible();
});

test("Add to the selected environment adds an empty cell in the matrix and focuses it", async ({ page }) => {
  await headerValue(page, "{{token}}");
  await selectEnvironment(page, "staging");
  await strip(page).getByRole("button", { name: "Add token to staging" }).click();

  const modal = dialog(page, "Environments");
  const matrix = modal.getByRole("group", { name: "Environments matrix" });
  const field = page.getByRole("textbox", { name: "token in staging", exact: true });
  await expect(field).toBeFocused();
  // Defined, though empty, so no longer a gap; local's Secret is untouched.
  await expect(matrix.locator(".m-cell.gap")).toHaveCount(0);
  await expect(matrix.locator(".kv-row .m-name")).toHaveText(["baseUrl", "token", "version"]);
  await expect(page.getByRole("textbox", { name: "token in local", exact: true })).toHaveText("•••••••••••••");

  await page.keyboard.type("stg-1");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
  await expect(count(page, "Headers")).toHaveCount(0);
});

test("Add to the selected environment adds an empty variable there and focuses its value (list view)", async ({ page }) => {
  await headerValue(page, "{{apiKey}}");
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentList(page);
  await expect.poll(async () => (await mockState(page, "settings")).envView).toBe("list");
  await page.keyboard.press("Escape");
  await expect(dialog(page, "Environments")).toHaveCount(0);
  await strip(page).getByRole("button", { name: "Add apiKey to local" }).click();

  const modal = dialog(page, "Environments");
  await expect(modal.locator(".main-head .title")).toHaveText("local");
  const grid = modal.getByRole("group", { name: "Variables" });
  await expect.poll(() => names(grid)).toEqual(["baseUrl", "token", "apiKey"]);
  await expect.poll(() => focusedRow(page)).toEqual({ name: "apiKey", inValue: true });

  await page.keyboard.type("k-123");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
  await expect(count(page, "Headers")).toHaveCount(0);
});

test("Add as File variable adds an `@name =` row in Settings and focuses its value", async ({ page }) => {
  await headerValue(page, "{{apiKey}}");
  await strip(page).getByRole("button", { name: "Add as File variable" }).click();

  await expect(subtab(page, "Settings")).toHaveClass(/active/);
  const grid = page.getByRole("group", { name: "File variables" });
  await expect.poll(() => names(grid)).toEqual(["petId", "apiKey"]);
  await expect.poll(() => focusedRow(page)).toEqual({ name: "apiKey", inValue: true });

  // An empty File variable already defines it.
  await expect(strip(page)).toHaveCount(0);
  await page.keyboard.type("k-123");
  await expect(grid.locator(".kv-row:not(.ghost) .c-value").nth(1)).toHaveText("k-123");
});

test("Select environment switches to one that defines it, and the strip updates", async ({ page }) => {
  await headerValue(page, "{{token}}");
  await expect(strip(page)).toHaveCount(0);

  await selectEnvironment(page, "staging");
  await expect(strip(page).getByRole("listitem")).toHaveText([/token.*used in Headers/]);
  await expect(strip(page).getByRole("button")).toHaveText(["Add token to staging", "Add as File variable", "Select environment local, which defines it"]);

  await strip(page).getByRole("button", { name: "Select environment local" }).click();
  await expect(page.getByRole("combobox", { name: "Active environment" })).toHaveText("local");
  await expect(strip(page)).toHaveCount(0);

  // With no environment selected there is none to add it to.
  await selectEnvironment(page, "No environment");
  await expect(strip(page).getByRole("listitem")).toHaveText([/baseUrl.*used in URL/, /token.*used in Headers/]);
  await expect(strip(page).getByRole("listitem").nth(1).getByRole("button")).toHaveText(["Add as File variable", "Select environment local, which defines it"]);
});
