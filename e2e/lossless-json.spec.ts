// JSON is formatted in the core without re-parsing numbers (#57): Pretty view
// and Beautify only change whitespace, so 64-bit IDs, `10.50` and `1e3` stay
// exactly as written. The mocked `format_body` re-indents tokens like the core.
import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, mockState, openApp, openRequest } from "./helpers";

function savedFiles(page: Page) {
  return mockState(page, "files");
}

test("Pretty view shows a 64-bit ID exactly as the server sent it", async ({ page }) => {
  await openApp(page, "?response=bigint");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  const body = page.locator(".body .cm-content");
  await expect(body).toContainText('"id": 9007199254740993,');
  await expect(body).toContainText('"price": 10.50,');
  await expect(body).not.toContainText("9007199254740992");
});

test("Pretty view of a JSON response that doesn't parse shows the raw body", async ({ page }) => {
  await openApp(page, "?response=invalidJson");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");

  await expect(page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Pretty" })).toBeChecked();
  await expect(page.locator(".body .cm-content")).toHaveText('{"id": 9007199254740993, oops}');
});

test("Beautify keeps 10.50 and 1e3 as written, and saving writes them unchanged", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  const editor = bodyEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"price":10.50,"e":1e3,"id":9007199254740993}');

  await page.getByRole("button", { name: "Beautify" }).click();
  const pretty = '{\n  "price": 10.50,\n  "e": 1e3,\n  "id": 9007199254740993\n}';
  await expect(editor.locator(".cm-line")).toHaveText(pretty.split("\n"));

  await page.keyboard.press("Meta+S");
  await expect
    .poll(async () => (await savedFiles(page))["/demo/api/pets.http"].requests.find((r) => r.name === "Create pet")?.body.text)
    .toBe(pretty);
});

test("Beautify leaves a body that isn't valid JSON untouched", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  const editor = bodyEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"id": {{petId}},  "price": 10.50}');

  await page.getByRole("button", { name: "Beautify" }).click();
  await page.waitForTimeout(200);
  await expect(editor.locator(".cm-line")).toHaveText(['{"id": {{petId}},  "price": 10.50}']);
});
