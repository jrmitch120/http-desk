// While one view of a file holds text that doesn't parse, the file's other views are
// read-only until it parses again, and say why (#174): the file view's broken text locks
// its request tabs, and a request's broken source locks the file view. Saving the file
// view then asks what to keep, as a request does (#164).
import { expect, test, type Page } from "@playwright/test";
import { dialog, fileText, openApp, openRequest, tab } from "./helpers";

const PETS = "/demo/api/pets.http";
const fileView = (page: Page) => page.locator(".file-view .file-code");
const line = (page: Page, text: string) => fileView(page).locator(".cm-line", { hasText: text });
const viewAsText = (page: Page) => page.getByRole("button", { name: "View file as text" });
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

/** Puts the cursor at the end of Create pet's request line, in the file view. */
async function toCreateLineEnd(page: Page) {
  await line(page, "POST {{baseUrl}}/pets").click();
  await page.keyboard.press("End");
}

/** Types `typed` at the end of Create pet's request line, in the file view, and waits for it to be read. */
async function breakCreateLine(page: Page, typed: string) {
  await toCreateLineEnd(page);
  await page.keyboard.type(typed);
  await expect(fileView(page).locator(".cm-underline-error")).toContainText(typed);
}

test("a broken line in the file view makes an open request tab of the file read-only, and saying why; fixing it makes the tab editable again", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await breakCreateLine(page, " and more");

  await tab(page, "Create pet").click();
  const banner = page.getByRole("status").filter({ hasText: "file view doesn't parse" });
  await expect(banner).toContainText("The text in pets.http's file view doesn't parse. Until it does, this request can't be edited here.");
  await expect(page.locator(".urlbar .cm-content")).not.toBeEditable();
  await expect(page.locator(".crumbs .name-input")).not.toBeEditable();
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await expect(page.locator(".kv-row .c-name").first()).not.toBeEditable();
  // Sending still sends the request as it last read.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  // The banner leads to the text, and fixing it unlocks the tab.
  await banner.getByRole("button", { name: /Show line \d+ in the file view/ }).click();
  await toCreateLineEnd(page);
  for (let i = 0; i < " and more".length; i++) await page.keyboard.press("Backspace");
  await expect(fileView(page).locator(".cm-underline-error")).toHaveCount(0);
  await tab(page, "Create pet").click();
  await expect(banner).toBeHidden();
  await expect(page.locator(".urlbar .cm-content")).toBeEditable();
  await expect(page.locator(".kv-row .c-name").first()).toBeEditable();
});

test("a request's source that doesn't parse makes the file view read-only, and saying why", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  await tab(page, "Create pet").click();
  await page.getByRole("button", { name: ".http", exact: true }).click();
  await page.locator(".source-code .cm-line", { hasText: "POST {{baseUrl}}/pets" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(page.locator(".source-code .cm-underline-error")).toContainText(" and more");

  await tab(page, "pets.http").click();
  await expect(page.getByRole("status").filter({ hasText: "doesn't parse" })).toContainText(
    `The source of "Create pet" doesn't parse. Until it does, pets.http can't be edited here.`,
  );
  await expect(fileView(page).locator(".cm-content")).not.toBeEditable();
});

test("Save as written from the file view writes its text verbatim; Revert restores the last valid file", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await viewAsText(page).click();
  const before = await fileText(page, PETS);

  await breakCreateLine(page, " and more");
  await saveButton(page).click();
  await dialog(page, 'Save "pets.http" as written?').getByRole("button", { name: "Save as written" }).click();
  await expect.poll(() => fileText(page, PETS)).toBe(before.replace("POST {{baseUrl}}/pets\n", "POST {{baseUrl}}/pets and more\n"));
  await expect(saveButton(page).locator(".dot")).toBeHidden();
  await expect(line(page, "POST {{baseUrl}}/pets")).toHaveText("POST {{baseUrl}}/pets and more");

  // Fixed, then broken again: Revert saves the file as it last parsed.
  await toCreateLineEnd(page);
  for (let i = 0; i < " and more".length; i++) await page.keyboard.press("Backspace");
  await expect(fileView(page).locator(".cm-underline-error")).toHaveCount(0);
  await breakCreateLine(page, " again");
  await saveButton(page).click();
  await dialog(page, 'Save "pets.http" as written?').getByRole("button", { name: "Revert to last valid" }).click();
  await expect(saveButton(page).locator(".dot")).toBeHidden();
  expect(await fileText(page, PETS)).toBe(before);
  await expect(line(page, "POST {{baseUrl}}/pets")).toHaveText("POST {{baseUrl}}/pets");
});
