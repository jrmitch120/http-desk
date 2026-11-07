// The Environments editor: variables live in the shared key/value grid (#52),
// with a lock column that makes a variable a Secret. The mocked `local`
// environment has a Secret (`token`).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockState, openApp, showEnvironmentList } from "./helpers";

const warning = /http-client\.private\.env\.json is not ignored by git/;

/** Opens the Environments editor's list on `local` and returns its variable grid. */
async function variables(page: Page): Promise<Locator> {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentList(page);
  return page.getByRole("dialog", { name: "Environments" }).getByRole("group", { name: "Variables" });
}

const names = (grid: Locator) => grid.locator(".kv-row:not(.ghost) input.c-name");

test("warns when the private env file is not ignored by git", async ({ page }) => {
  await openApp(page, "?privateFileIgnored=false");
  await page.getByRole("button", { name: "Manage environments" }).click();
  await expect(page.getByText(warning)).toBeVisible();
});

test("shows no warning when the private env file is ignored", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  await expect(page.getByPlaceholder("Filter variables")).toBeVisible();
  await expect(page.getByText(warning)).toHaveCount(0);
});

test("variables are added in the ghost row, edited and deleted like params", async ({ page }) => {
  const grid = await variables(page);
  await expect(page.getByRole("dialog", { name: "Environments" }).locator("table")).toHaveCount(0);
  await expect(names(grid)).toHaveCount(2);

  // Typing into the ghost row keeps focus there, and Tab moves on to its value.
  await grid.getByPlaceholder("Add variable").click();
  await page.keyboard.type("apiKey");
  await expect(grid.locator("input.c-name").nth(2)).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.type("abc");
  await expect(names(grid)).toHaveCount(3);
  await expect(grid.locator(".kv-row").nth(2).locator(".c-value")).toHaveText("abc");

  await grid.locator("input.c-name").first().fill("host");
  await expect(grid.locator("input.c-name").first()).toHaveValue("host");

  const del = grid.getByRole("button", { name: "Delete" }).nth(1);
  await grid.locator(".kv-row").nth(1).hover();
  await del.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Delete");
  await del.click();
  await expect(names(grid)).toHaveCount(2);
  await expect(names(grid).nth(1)).toHaveValue("apiKey");
});

test("the filter narrows the variables by name or shareable value", async ({ page }) => {
  const grid = await variables(page);
  const filter = page.getByPlaceholder("Filter variables");

  await filter.fill("tok");
  await expect(names(grid)).toHaveCount(1);
  await expect(names(grid).first()).toHaveValue("token");

  // A Secret's value isn't searched.
  await filter.fill("dev-token");
  await expect(names(grid)).toHaveCount(0);
  await filter.fill("127.0.0");
  await expect(names(grid)).toHaveCount(1);
  await expect(names(grid).first()).toHaveValue("baseUrl");

  // The ghost row stays, and a variable added while filtering stays visible.
  await grid.getByPlaceholder("Add variable").fill("apiKey");
  await expect(names(grid)).toHaveCount(2);
  await expect(names(grid).nth(1)).toHaveValue("apiKey");
  await expect(names(grid).nth(1)).toBeFocused();

  // Deleting a row while filtering deletes that row, not the one at its visible position.
  await filter.fill("tok");
  await expect(names(grid)).toHaveCount(1);
  await grid.locator(".kv-row").first().hover();
  await grid.getByRole("button", { name: "Delete" }).first().click();
  await filter.fill("");
  await expect(names(grid)).toHaveCount(2);
  await expect(names(grid).first()).toHaveValue("baseUrl");
  await expect(names(grid).nth(1)).toHaveValue("apiKey");
});

test("variables have no bulk edit, which would show Secrets as plain text", async ({ page }) => {
  const grid = await variables(page);
  await expect(grid.locator(".kv-row").first()).toBeVisible();
  await expect(grid.getByRole("button", { name: "Bulk edit" })).toHaveCount(0);
});

const envFiles = (page: Page) => mockState(page, "envFiles");

test("the lock column makes a variable a Secret, saved only to the private file", async ({ page }) => {
  const grid = await variables(page);
  await grid.getByPlaceholder("Add variable").fill("apiKey");
  const row = grid.locator(".kv-row:not(.ghost)").last();
  // A variable-aware field (#80): typed into, and a Secret's text is shown as discs.
  const value = row.locator(".c-value .var-field");
  await value.click();
  await page.keyboard.type("s3cret");
  await page.keyboard.press("Tab");
  await expect(value).toHaveText("s3cret");

  // One name for both states; aria-pressed says which, the tooltip says where the value goes.
  const lock = row.getByRole("button", { name: "Secret", exact: true });
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await lock.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Shareable: saved in http-client.env.json. Click to make it a Secret.");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await lock.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Secret: saved only in http-client.private.env.json. Click to make it shareable.");
  await expect(value).toHaveText("••••••");
  await row.getByRole("button", { name: "Show value" }).click();
  await expect(value).toHaveText("s3cret");

  await page.getByRole("dialog", { name: "Environments" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.private.local).toEqual({ token: "dev-token-123", apiKey: "s3cret" });
  expect(files.shared.local).toEqual({ baseUrl: "http://127.0.0.1:8765" });
});
