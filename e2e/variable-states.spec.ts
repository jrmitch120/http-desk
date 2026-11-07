import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest, urlBar } from "./helpers";

/** Adds a File variable through the request's Settings section (the ghost row, then Tab to its value). */
async function addFileVariable(page: Page, name: string, value: string) {
  await page.getByPlaceholder("Add variable").click();
  await page.keyboard.type(name);
  await page.keyboard.press("Tab");
  await page.keyboard.type(value);
}

/** Opens "List pets" with File variables a = {{b}}, b = {{a}} and api = {{baseUrl}}/v2. */
async function withCircularVariables(page: Page, request = "List pets") {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], request);
  await page.locator(".subtab", { hasText: "Settings" }).click();
  await addFileVariable(page, "a", "{{b}}");
  await addFileVariable(page, "b", "{{a}}");
  await addFileVariable(page, "api", "{{baseUrl}}/v2");
}

const tooltip = (page: Page) => page.locator(".popup-layer .cm-tooltip");

test("a circular reference in the URL has its own colour and hover, unlike an Undefined variable", async ({ page }) => {
  await withCircularVariables(page);
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("/{{a}}/{{nope}}/{{api}}");

  const circular = page.locator(".url-input .cm-var-circular");
  const undefinedVar = page.locator(".url-input .cm-var-bad");
  await expect(circular).toHaveText("{{a}}");
  await expect(undefinedVar).toHaveText("{{nope}}");
  const color = (l: typeof circular) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await color(circular)).not.toBe(await color(undefinedVar));

  await circular.hover();
  await expect(tooltip(page)).toContainText("Circular: a → b → a");
  await page.mouse.move(0, 0);
  await expect(tooltip(page)).toHaveCount(0);

  await undefinedVar.hover();
  await expect(tooltip(page)).toContainText("Undefined");
  await expect(tooltip(page)).not.toContainText("Circular");
  await page.mouse.move(0, 0);
  await expect(tooltip(page)).toHaveCount(0);

  // A nested value is shown fully resolved.
  await page.locator(".url-input .cm-var-ok", { hasText: "{{api}}" }).hover();
  await expect(tooltip(page)).toContainText("http://127.0.0.1:8765/v2");
});

test("a circular reference in the body has its own colour and hover", async ({ page }) => {
  await withCircularVariables(page, "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(' "{{b}}"');

  const circular = page.locator(".panel .cm-var-circular");
  await expect(circular).toHaveText("{{b}}");
  await circular.hover();
  await expect(tooltip(page)).toContainText("Circular: b → a → b");
});
