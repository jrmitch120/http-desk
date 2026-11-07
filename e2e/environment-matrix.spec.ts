// The Environments matrix (#83): variables as rows, Shared and each environment
// as columns, edited in place. The mock has shared `version`, `local` with
// `baseUrl` and a Secret `token`, and `staging` with only `baseUrl`.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp } from "./helpers";

/** Opens the Environments modal, which shows the matrix unless the list was picked. */
async function open(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Manage environments" }).click();
  return dialog(page, "Environments");
}

const matrix = (modal: Locator) => modal.getByRole("group", { name: "Environments matrix" });
/** The cell of variable `name` in `column` ("Shared" or an environment's name). */
const cell = (modal: Locator, name: string, column: string) =>
  matrix(modal).locator(".m-cell").filter({ has: modal.page().getByRole("textbox", { name: `${name} in ${column}`, exact: true }) });
const envFiles = (page: Page) => mockState(page, "envFiles");

test("shows every variable across Shared and the environments, with gaps highlighted", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const grid = matrix(modal);
  await expect(grid.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "Environment"]);
  await expect(grid.locator(".kv-row .m-name")).toHaveText(["version", "baseUrl", "token"]);
  await expect(grid.locator(".kv-row.ghost")).toHaveCount(0);

  await expect(cell(modal, "baseUrl", "staging")).toHaveText("https://staging.example.com");
  await expect(cell(modal, "token", "local").locator(".var-field")).toHaveText("•••••••••••••");

  // staging has no token and Shared doesn't supply one: a gap. Shared is optional, and
  // an environment without `version` uses the shared one, so neither is a gap.
  await expect(grid.locator(".m-cell.gap")).toHaveCount(1);
  await expect(cell(modal, "token", "staging")).toHaveClass(/\bgap\b/);
  const field = (name: string, column: string) => page.getByRole("textbox", { name: `${name} in ${column}`, exact: true });
  await expect(field("token", "staging")).toHaveAttribute("aria-placeholder", "Not set");
  await expect(cell(modal, "token", "Shared")).not.toHaveClass(/\bgap\b/);
  await expect(field("token", "Shared")).toHaveAttribute("aria-placeholder", "Not set");
  await expect(field("version", "local")).toHaveAttribute("aria-placeholder", "Uses shared");
});

test("a cell is edited in place, its gap clears, and Save writes it to that environment", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const gap = cell(modal, "token", "staging");
  await gap.locator(".var-field").click();
  await page.keyboard.type("stg-{{ver");
  await page.keyboard.press("Escape"); // closes the {{ list, not the modal
  await page.keyboard.type("sion}}");
  await expect(gap).not.toHaveClass(/\bgap\b/);
  await page.keyboard.press("Tab");
  await expect(gap.locator(".var-field")).toHaveText("stg-{{version}}");
  await expect(gap.locator(".cm-var-ok")).toHaveText("{{version}}");

  const baseUrl = cell(modal, "baseUrl", "local").locator(".var-field");
  await baseUrl.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("http://localhost:9000");
  await page.keyboard.press("Tab");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared.staging).toEqual({ baseUrl: "https://staging.example.com", token: "stg-{{version}}" });
  expect(files.shared.local).toEqual({ baseUrl: "http://localhost:9000" });
  expect(files.private.local).toEqual({ token: "dev-token-123" });
});

test("each cell has its own Secret toggle, and Save moves the value between the files", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const staging = cell(modal, "baseUrl", "staging");
  const local = cell(modal, "token", "local");
  await staging.getByRole("button", { name: "Secret" }).click();
  await expect(staging.getByRole("button", { name: "Secret" })).toHaveAttribute("aria-pressed", "true");
  await expect(staging.locator(".var-field")).toHaveText("•".repeat("https://staging.example.com".length));
  await staging.getByRole("button", { name: "Show value" }).click();
  await expect(staging.locator(".var-field")).toHaveText("https://staging.example.com");
  // Only that cell: local's baseUrl stays shareable.
  await expect(cell(modal, "baseUrl", "local").getByRole("button", { name: "Secret" })).toHaveAttribute("aria-pressed", "false");

  await local.getByRole("button", { name: "Secret" }).click();
  await expect(local.locator(".var-field")).toHaveText("dev-token-123");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.private.staging).toEqual({ baseUrl: "https://staging.example.com" });
  expect(files.shared.staging).toEqual({ baseUrl: "" }); // a Secret's placeholder, as before
  expect(files.shared.local).toEqual({ baseUrl: "http://127.0.0.1:8765", token: "dev-token-123" });
  expect(files.private.local).toBeUndefined();
});

test("Add variable to all environments adds a row every environment saves", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await modal.getByRole("button", { name: "Add variable to all environments" }).click();
  const ask = dialog(page, "Add variable to all environments");
  await ask.getByRole("textbox").fill("apiKey");
  await ask.getByRole("button", { name: "OK" }).click();

  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["version", "baseUrl", "token", "apiKey"]);
  await expect(cell(modal, "apiKey", "local")).not.toHaveClass(/\bgap\b/);
  await expect(cell(modal, "apiKey", "staging")).not.toHaveClass(/\bgap\b/);
  await cell(modal, "apiKey", "staging").locator(".var-field").click();
  await page.keyboard.type("k-stg");
  await page.keyboard.press("Tab");

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared.local.apiKey).toBe("");
  expect(files.shared.staging.apiKey).toBe("k-stg");
});

test("a row's menu deletes the variable from every environment", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await matrix(modal).locator(".m-name", { hasText: "baseUrl" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete from all environments" }).click();
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["version", "token"]);

  // The row's actions button opens the same menu.
  await matrix(modal).locator(".kv-row").filter({ hasText: "token" }).getByRole("button", { name: "Actions for token" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete from all environments" })).toBeVisible();
});

test("a hover card's Edit focuses the cell that defines the variable", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  await cell(modal, "token", "staging").locator(".var-field").click();
  await page.keyboard.type("{{version}}");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await cell(modal, "token", "staging").locator(".cm-var", { hasText: "{{version}}" }).hover();
  await page.locator(".var-card").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "version in Shared", exact: true })).toBeFocused();
});

test("the Matrix / List choice is remembered, and the filter narrows rows", async ({ page }) => {
  await openApp(page);
  let modal = await open(page);
  await modal.getByPlaceholder("Filter variables").fill("staging.example");
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["baseUrl"]);

  const view = modal.getByRole("radiogroup", { name: "View" });
  await expect(view.getByRole("radio", { name: "Matrix" })).toBeChecked();
  await view.getByRole("radio", { name: "List" }).click();
  await expect(matrix(modal)).toHaveCount(0);
  await expect(modal.getByRole("group", { name: "Variables" })).toBeVisible();
  await expect.poll(async () => (await mockState(page, "settings")).envView).toBe("list");

  await page.reload();
  modal = await open(page);
  await expect(modal.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "List" })).toBeChecked();
  await expect(modal.getByRole("group", { name: "Variables" })).toBeVisible();
});

test("the header's last cell adds an environment as a new column", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  // The only way to add one in the matrix: no stray button in the toolbar.
  const add = modal.getByRole("button", { name: "New environment" });
  await expect(add).toHaveCount(1);
  await expect(matrix(modal).locator(".kv-head")).toContainText("Environment");
  await add.click();
  const ask = dialog(page, "New environment");
  await ask.getByRole("textbox").fill("prod");
  await ask.getByRole("button", { name: "OK" }).click();
  await expect(matrix(modal).locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "prod", "Environment"]);
  await expect(cell(modal, "baseUrl", "prod")).toHaveClass(/\bgap\b/);
});

test("typing a value never moves a row, even where the variable is first seen", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");
  await expect(names).toHaveText(["version", "baseUrl", "token"]);
  // token was first seen in local; filling Shared's cell makes Shared define it first.
  await cell(modal, "token", "Shared").locator(".var-field").click();
  await page.keyboard.type("t");
  await expect(names).toHaveText(["version", "baseUrl", "token"]);
  await expect(page.getByRole("textbox", { name: "token in Shared", exact: true })).toBeFocused();
  await page.keyboard.type("ok");
  await page.keyboard.press("Tab");
  await expect(cell(modal, "token", "Shared")).toHaveText("tok");
  await expect(names).toHaveText(["version", "baseUrl", "token"]);
});

test("the Variable header sorts the rows by name, and the sort lasts the session", async ({ page }) => {
  await openApp(page);
  let modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");
  const header = matrix(modal).getByRole("columnheader", { name: "Variable" });
  const sort = header.getByRole("button", { name: "Variable" });
  await expect(header).toHaveAttribute("aria-sort", "none");

  await sort.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(names).toHaveText(["baseUrl", "token", "version"]);
  await sort.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(names).toHaveText(["version", "token", "baseUrl"]);
  await sort.press("Space");
  await expect(header).toHaveAttribute("aria-sort", "none");
  await expect(names).toHaveText(["version", "baseUrl", "token"]);

  // A to Z: a new variable takes its sorted place, and the filter still applies.
  await sort.click();
  await modal.getByRole("button", { name: "Add variable to all environments" }).click();
  const ask = dialog(page, "Add variable to all environments");
  await ask.getByRole("textbox").fill("apiKey");
  await ask.getByRole("button", { name: "OK" }).click();
  await expect(names).toHaveText(["apiKey", "baseUrl", "token", "version"]);
  await page.keyboard.type("zzz"); // a value sorts nothing
  await page.keyboard.press("Tab");
  await expect(names).toHaveText(["apiKey", "baseUrl", "token", "version"]);
  await modal.getByPlaceholder("Filter variables").fill("k");
  await expect(names).toHaveText(["apiKey", "token"]);

  // Kept when the modal opens again, but not saved with the settings.
  await modal.getByRole("button", { name: "Cancel" }).click();
  await dialog(page, "Discard changes?").getByRole("button", { name: "Discard" }).click();
  modal = await open(page);
  await expect(matrix(modal).getByRole("columnheader", { name: "Variable" })).toHaveAttribute("aria-sort", "ascending");
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["baseUrl", "token", "version"]);
  await page.reload();
  modal = await open(page);
  await expect(matrix(modal).locator(".kv-row .m-name")).toHaveText(["version", "baseUrl", "token"]);
});

test("a cell's Unset button and context menu remove the variable from that column, and Save drops it from both files", async ({ page }) => {
  await openApp(page);
  const modal = await open(page);
  const names = matrix(modal).locator(".kv-row .m-name");

  // The button shows on hover, only on a cell that's set.
  const staging = cell(modal, "baseUrl", "staging");
  const unset = staging.getByRole("button", { name: "Unset" });
  await expect(unset).toHaveCSS("opacity", "0");
  await staging.hover();
  await expect(unset).toHaveCSS("opacity", "1");
  await expect(cell(modal, "token", "staging").getByRole("button", { name: "Unset" })).toHaveCount(0);
  await unset.click();
  await expect(staging).toHaveClass(/\bgap\b/);
  await expect(page.getByRole("textbox", { name: "baseUrl in staging", exact: true })).toHaveAttribute("aria-placeholder", "Not set");
  await expect(staging.getByRole("button", { name: "Unset" })).toHaveCount(0);

  // An empty value is still set until it's unset.
  const local = cell(modal, "baseUrl", "local");
  await local.locator(".var-field").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await expect(local).not.toHaveClass(/\bgap\b/);
  await local.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in local" }).click();
  await expect(local).toHaveClass(/\bgap\b/);
  // No column defines baseUrl now; its row stays until the modal closes.
  await expect(names).toHaveText(["version", "baseUrl", "token"]);

  // A Secret, and a shared variable (an environment without its own then has a gap).
  await cell(modal, "token", "local").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in local" }).click();
  await cell(modal, "version", "Shared").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unset in Shared" }).click();
  await expect(page.getByRole("textbox", { name: "version in Shared", exact: true })).toHaveAttribute("aria-placeholder", "Not set");
  await expect(cell(modal, "version", "local")).toHaveClass(/\bgap\b/);

  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.shared).toEqual({ $shared: {}, local: {}, staging: {} });
  expect(files.private).toEqual({});
});
