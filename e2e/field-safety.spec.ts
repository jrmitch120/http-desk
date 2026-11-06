import { expect, test } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

test("single-line fields drop pasted line breaks", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  const name = page.locator(".crumbs .name-input");
  await name.fill("List\npets");
  await expect(name).not.toHaveValue(/\n/);

  await page.locator(".subtab", { hasText: "Headers" }).click();
  const value = page.getByPlaceholder("Value").first();
  await value.fill("*/*\nX-Injected: 1");
  await expect(value).not.toHaveValue(/\n/);
});

test("header names that would break the file show an inline error", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();

  const name = page.getByPlaceholder("Add header");
  await name.fill("X Trace");
  const row = page.locator(".kv-row").filter({ has: page.locator('input[aria-invalid="true"]') });
  await expect(row.getByRole("alert")).toHaveText("Header names can't contain spaces");

  await row.locator("input.c-name").fill("X-Trace");
  await expect(page.getByText("Header names can't contain spaces")).toHaveCount(0);
});

test("file variable names are validated", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Settings" }).click();

  await page.getByPlaceholder("Add variable").fill("base url");
  await expect(page.getByRole("alert")).toHaveText("Variable names can only use letters, digits, _, -, . and $");
});

test("a Basic auth username containing ':' shows an inline error", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Authorization" }).click();
  await page.locator(".auth select").first().selectOption("basic");

  const username = page.getByPlaceholder("{{username}}");
  await username.fill("dom:ain");
  await expect(username).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveText("Basic auth usernames can't contain ':'");

  await username.fill("domain");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a body line starting with ### shows an inline warning", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.locator(".subtab", { hasText: "Body" }).click();

  const editor = page.locator(".code .cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("### Heading");

  const warning = page.locator(".syntax-warnings");
  await expect(warning).toContainText("starts with ###, so it will be read as the start of a new request");
  await expect(page.locator(".cm-line.cm-syntax-warning")).toHaveText("### Heading");

  await page.keyboard.press("Home");
  await page.keyboard.type(" ");
  await expect(warning).toHaveCount(0);
});
