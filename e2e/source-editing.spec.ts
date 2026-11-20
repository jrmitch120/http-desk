// A request's .http source is editable (#163): what's typed is read by the core and
// the structured editors follow; an edit in them shows in the source, which keeps
// its cursor. ⌥⌘U (Ctrl+Alt+U) switches between the two views.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const toggle = (page: Page) => page.getByRole("button", { name: ".http", exact: true });
const source = (page: Page) => page.locator(".source-code");
/** The source editor's text, lines joined with newlines. */
const sourceText = (page: Page) =>
  source(page).evaluate((el) => [...el.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"));
/** The Headers table's rows as `name: value` (the new-row ghost left out). */
const headerRows = (page: Page) =>
  page
    .locator(".kv-row")
    .filter({ has: page.getByRole("button", { name: "Delete" }) })
    .evaluateAll((rows) =>
      rows.map((row) => `${row.querySelector<HTMLInputElement>(".c-name")!.value}: ${row.querySelector(".c-value")!.textContent}`),
    );
const SWITCH = "Meta+Alt+KeyU";

test("the shortcut switches between the sections and the source", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press(SWITCH);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(source(page)).toContainText("### List pets");
  await expect(page.locator(".subtab", { hasText: "Headers" })).toBeHidden();

  await page.keyboard.press(SWITCH);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(source(page)).toBeHidden();
  await expect(page.locator(".subtab", { hasText: "Headers" })).toBeVisible();

  await toggle(page).hover();
  await expect(page.getByRole("tooltip")).toContainText("(⌥⌘U)");
});

test("a header typed into the source shows in the Headers table", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await toggle(page).click();

  await source(page).locator(".cm-line", { hasText: "Accept: application/json" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("X-Typed: yes");
  await expect(page.getByRole("button", { name: "Save", exact: true }).locator(".dot")).toBeVisible();

  await page.keyboard.press(SWITCH);
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await expect.poll(() => headerRows(page)).toEqual(["Accept: application/json", "X-Typed: yes", "X-Debug: true"]);
});

test("a header added in the table shows in the source, and the cursor stays where it was", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await toggle(page).click();
  await source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" }).click();
  await page.keyboard.press("End");

  await page.keyboard.press(SWITCH);
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await page.getByPlaceholder("Add header").fill("X-Added");
  await page.keyboard.press("Tab");
  await page.keyboard.type("1");

  await page.keyboard.press(SWITCH);
  await expect.poll(() => sourceText(page)).toContain("#~ X-Debug: true\nX-Added: 1\n");
  // Typing goes on at the end of the URL line.
  await page.keyboard.type("&page=2");
  await expect.poll(() => sourceText(page)).toContain("GET {{baseUrl}}/pets?limit=20&page=2\n");
  // The structured edit started a new undo history: undo takes back only the typing.
  // CodeMirror's Undo key, so the test machine's (helpers.ts openApp).
  await page.keyboard.press("ControlOrMeta+KeyZ");
  await expect.poll(() => sourceText(page)).toContain("GET {{baseUrl}}/pets?limit=20\n#~ &status=sold");
  await page.keyboard.press("ControlOrMeta+KeyZ");
  await expect.poll(() => sourceText(page)).toContain("X-Added: 1");
});

test("text that doesn't parse keeps the request as it last was, and reads unsaved", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await toggle(page).click();

  await source(page).locator(".cm-line", { hasText: "GET {{baseUrl}}/pets" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(page.getByRole("button", { name: "Save", exact: true }).locator(".dot")).toBeVisible();
  // The typed text's problem, at its place in that text (#165's strip and underline).
  await expect(page.getByRole("region", { name: "Pre-send checks" }).getByRole("listitem")).toHaveText([/Line 6\s*Can't read this request line/]);
  await expect(source(page).locator(".cm-underline-error")).toHaveText("GET {{baseUrl}}/pets?limit=20 and more");

  await page.keyboard.press(SWITCH);
  await page.locator(".subtab", { hasText: "Params" }).click();
  await expect(page.locator(".urlbar")).toContainText("{{baseUrl}}/pets?limit=20");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await expect.poll(() => headerRows(page)).toEqual(["Accept: application/json", "X-Debug: true"]);
});
