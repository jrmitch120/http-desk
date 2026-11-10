// Minify, XML Beautify and the Hex view go through the core (#60): the body
// editor calls `format_body`, and the Hex view is `hexdump` of the stored body
// by response id. The mock stands in for both.
import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest } from "./helpers";

async function typeBody(page: Page, text: string) {
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

test("Minify compacts a pretty JSON body to one line, keeping its numbers", async ({ page }) => {
  await openApp(page);
  await typeBody(page, '{\n  "price": 10.50,\n  "e": 1e3,\n  "id": 9007199254740993,\n  "tags": [ "a b" ]\n}');

  await page.getByRole("button", { name: "Minify" }).click();
  await expect(bodyEditor(page).locator(".cm-line")).toHaveText(['{"price":10.50,"e":1e3,"id":9007199254740993,"tags":["a b"]}']);

  await page.getByRole("button", { name: "Beautify" }).click();
  await expect(bodyEditor(page).locator(".cm-line")).toHaveText([
    "{",
    '  "price": 10.50,',
    '  "e": 1e3,',
    '  "id": 9007199254740993,',
    '  "tags": [',
    '    "a b"',
    "  ]",
    "}",
  ]);
});

test("Minify leaves a body that isn't valid JSON unchanged", async ({ page }) => {
  await openApp(page);
  await typeBody(page, '{\n  "id": {{petId}},\n  "price": 10.50\n}');

  await page.getByRole("button", { name: "Minify" }).click();
  await page.waitForTimeout(200);
  await expect(bodyEditor(page).locator(".cm-line")).toHaveText(["{", '  "id": {{petId}},', '  "price": 10.50', "}"]);
});

test("Minify is offered for JSON bodies only", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await expect(page.getByRole("button", { name: "Minify" })).toBeVisible();

  await page.getByRole("radiogroup", { name: "Body type" }).getByRole("radio", { name: "XML" }).click();
  await expect(page.getByRole("button", { name: "Beautify" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minify" })).toHaveCount(0);
});

test("Beautify formats an XML body in the core", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  await page.getByRole("radiogroup", { name: "Body type" }).getByRole("radio", { name: "XML" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("<pet><name>Rex</name><tags><tag>good</tag></tags></pet>");

  await page.getByRole("button", { name: "Beautify" }).click();
  await expect(bodyEditor(page).locator(".cm-line")).toHaveText([
    "<pet>",
    "  <name>Rex</name>",
    "  <tags>",
    "    <tag>good</tag>",
    "  </tags>",
    "</pet>",
  ]);
});

test("the Hex view of a binary response is the core's dump of the stored body", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await page.keyboard.press("Meta+Enter");

  await page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Hex" }).click();
  await expect(page.locator(".body .cm-line").first()).toHaveText("00000000  89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52  .PNG........IHDR");
});
