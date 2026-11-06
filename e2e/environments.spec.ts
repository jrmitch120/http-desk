// The Environments editor: variables live in the shared key/value grid (#52),
// with a lock column that makes a variable a Secret. The mocked `local`
// environment has a Secret (`token`).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./helpers";

const warning = /http-client\.private\.env\.json is not ignored by git/;

/** Opens the Environments editor on `local` and returns its variable grid. */
async function variables(page: Page): Promise<Locator> {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
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
  await expect(grid.locator(".c-value input").nth(2)).toHaveValue("abc");

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

type EnvFiles = { shared: Record<string, Record<string, unknown>>; private: Record<string, Record<string, unknown>> };
const envFiles = (page: Page) => page.evaluate(() => (window as unknown as { __mock: { envFiles: EnvFiles } }).__mock.envFiles);

test("the lock column makes a variable a Secret, saved only to the private file", async ({ page }) => {
  const grid = await variables(page);
  await grid.getByPlaceholder("Add variable").fill("apiKey");
  const row = grid.locator(".kv-row:not(.ghost)").last();
  const value = row.locator(".c-value input");
  await value.fill("s3cret");
  await expect(value).toHaveAttribute("type", "text");

  const lock = row.getByRole("button", { name: /click to mark as secret/ });
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await lock.click();
  await expect(row.getByRole("button", { name: /click to make shareable/ })).toHaveAttribute("aria-pressed", "true");
  await expect(value).toHaveAttribute("type", "password");
  await row.getByRole("button", { name: "Show value" }).click();
  await expect(value).toHaveAttribute("type", "text");

  await page.getByRole("dialog", { name: "Environments" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Environments saved")).toBeVisible();
  const files = await envFiles(page);
  expect(files.private.local).toEqual({ token: "dev-token-123", apiKey: "s3cret" });
  expect(files.shared.local).toEqual({ baseUrl: "http://127.0.0.1:8765" });
});
