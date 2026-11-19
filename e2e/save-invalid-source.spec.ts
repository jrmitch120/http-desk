// Saving while a request's source doesn't parse asks what to keep (#164): Save as
// written puts the text in the file as typed; Revert to last valid saves the
// request as it last parsed.
import { expect, test, type Page } from "@playwright/test";
import { fileText, openApp, openRequest } from "./helpers";

const PETS = "/demo/api/pets.http";
const source = (page: Page) => page.locator(".source-code");
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

/** Puts the cursor at the end of the request line, in the Source view. */
async function toRequestLineEnd(page: Page) {
  await source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" }).click();
  await page.keyboard.press("End");
}

/** Types `typed` at the end of the request line, in the Source view. */
async function breakRequestLine(page: Page, typed: string) {
  await toRequestLineEnd(page);
  await page.keyboard.type(typed);
  await expect(source(page).locator(".cm-underline-error")).toContainText(typed);
}

test("Save as written puts the broken line in the file; Revert saves the last valid request", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("button", { name: ".http", exact: true }).click();

  await breakRequestLine(page, " and more");
  await saveButton(page).click();
  const dialog = page.getByRole("dialog", { name: 'Save "List pets" as written?' });
  await dialog.getByRole("button", { name: "Save as written" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => fileText(page, PETS)).toContain("\nGET {{baseUrl}}/pets?limit=20 and more\n#~ &status=sold\n");
  await expect(saveButton(page).locator(".dot")).toBeHidden();
  // The source still shows the text as typed.
  await expect(source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" })).toHaveText("GET {{baseUrl}}/pets?limit=20 and more");

  // Fixed (the request parses again, with a new header), then broken again.
  await toRequestLineEnd(page);
  for (let i = 0; i < " and more".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type("\nX-Fixed: yes");
  // Read: the URL bar shows the request as it now parses.
  await expect(page.locator(".urlbar")).not.toContainText("more");
  await breakRequestLine(page, " again");
  await saveButton(page).click();
  await page.getByRole("dialog", { name: 'Save "List pets" as written?' }).getByRole("button", { name: "Revert to last valid" }).click();
  await expect(saveButton(page).locator(".dot")).toBeHidden();
  const saved = await fileText(page, PETS);
  expect(saved).toContain("\nGET {{baseUrl}}/pets?limit=20\n#~ &status=sold\nX-Fixed: yes\n");
  expect(saved).not.toContain("again");
  await expect(source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" })).toHaveText("GET {{baseUrl}}/pets?limit=20");
});
