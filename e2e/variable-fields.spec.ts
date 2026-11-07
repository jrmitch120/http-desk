// Variable-aware value cells (#76): params and header values highlight
// {{variables}}, show the hover card and autocomplete them like the URL bar. A
// row shows a static rendering and only gets an editor while its cell has focus.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests, urlBar } from "./helpers";

/** Opens List pets on a section (the `local` environment is selected: baseUrl, Secret token). */
async function openSection(page: Page, section: "Params" | "Headers"): Promise<void> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: section }).click();
}

/** The value cell of the `n`th row of the section's grid. */
const valueCell = (page: Page, n: number): Locator => page.locator(".kv-row").nth(n).locator(".c-value");
/** Editors in the section's grid. */
const editors = (page: Page): Locator => page.locator(".kv .cm-editor");

/** Replaces a value cell's text by typing. */
async function retype(page: Page, cell: Locator, text: string): Promise<void> {
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test("variables in a header value are highlighted by state, with and without an editor", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = valueCell(page, 0);
  await retype(page, cell, "{{baseUrl}} {{token}} {{nope}} {{$uuid}}");

  for (const editing of [true, false]) {
    await expect(editors(page)).toHaveCount(editing ? 1 : 0);
    await expect(cell.locator(".cm-var-ok")).toHaveText(["{{baseUrl}}", "{{token}}"]);
    await expect(cell.locator(".cm-var-secret")).toHaveText("{{token}}");
    await expect(cell.locator(".cm-var-bad")).toHaveText("{{nope}}");
    await expect(cell.locator(".cm-var-dyn")).toHaveText("{{$uuid}}");
    if (editing) await page.keyboard.press("Tab");
  }
  await expect(cell).toHaveText("{{baseUrl}} {{token}} {{nope}} {{$uuid}}");
  // The URL bar marks a Secret the same way.
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?t={{token}}");
  await expect(page.locator(".url-input .cm-var-secret")).toHaveText("{{token}}");
});

test("typing {{ in a param value opens variable autocomplete", async ({ page }) => {
  await openSection(page, "Params");
  await page.getByPlaceholder("Add key").click();
  await page.keyboard.type("q");
  await page.keyboard.press("Tab");
  await page.keyboard.type("{{ba");

  const list = page.locator(".popup-layer .cm-tooltip-autocomplete");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").first()).toHaveText(/^baseUrl/);
  // CodeMirror ignores Enter for 75 ms after the list opens (a guard against accepting by accident).
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(list).toBeHidden({ timeout: 200 });
  }).toPass();

  // List pets has two params (limit, status), so q is the third row.
  const cell = valueCell(page, 2);
  await expect(cell).toHaveText("{{baseUrl}}");
  await expect(cell.locator(".cm-var-ok")).toHaveText("{{baseUrl}}");
  await expect(urlBar(page)).toHaveText("{{baseUrl}}/pets?limit=20&q={{baseUrl}}");
});

test("only the focused value cell has an editor, and the keyboard moves between cells as before", async ({ page }) => {
  await openSection(page, "Headers");
  await expect(page.locator(".kv-row:not(.ghost)")).toHaveCount(2);
  await expect(editors(page)).toHaveCount(0);

  // Tab from a name into its value selects the value, as in a text input.
  const accept = page.locator(".kv-row").nth(0);
  await accept.locator("input.c-name").click();
  await page.keyboard.press("Tab");
  const content = accept.locator(".c-value .cm-content");
  await expect(content).toBeFocused();
  await expect(editors(page)).toHaveCount(1);
  await page.keyboard.type("text/plain");
  await expect(content).toHaveText("text/plain");

  // Arrows move the caret and Enter adds no line.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.keyboard.type("-x");
  await expect(content).toHaveText("text/pla-xin");
  await expect(content.locator(".cm-line")).toHaveCount(1);

  // Tab on to the row's delete button, back to the value, back to the name.
  await page.keyboard.press("Tab");
  await expect(accept.getByRole("button", { name: "Delete" })).toBeFocused();
  await expect(editors(page)).toHaveCount(0);
  await expect(accept.locator(".c-value")).toHaveText("text/pla-xin");
  await page.keyboard.press("Shift+Tab");
  await expect(content).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(accept.locator("input.c-name")).toBeFocused();
  await expect(editors(page)).toHaveCount(0);

  // A click puts the caret where it lands.
  await accept.locator(".c-value").click({ position: { x: 20, y: 15 } });
  await page.keyboard.type("!");
  await expect(content).toHaveText("t!ext/pla-xin");

  // Typing a value into the ghost row adds a row and keeps typing in it.
  await page.locator(".kv-row.ghost .c-value").click();
  await page.keyboard.type("abc");
  await expect(page.locator(".kv-row:not(.ghost)")).toHaveCount(3);
  await expect(page.locator(".kv-row").nth(2).locator(".c-value .cm-content")).toBeFocused();
  await expect(page.locator(".kv-row").nth(2).locator(".c-value")).toHaveText("abc");
});

test("line breaks can't be typed or pasted into a value", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = valueCell(page, 0);
  await retype(page, cell, "*/*");
  await page.keyboard.press("Enter");
  await cell.locator(".cm-content").evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "\nX-Injected: 1\r\n  more");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(cell.locator(".cm-line")).toHaveCount(1);
  await expect(cell).toHaveText("*/*X-Injected: 1more");
  await page.keyboard.press("Tab");
  await expect(cell).toHaveText("*/*X-Injected: 1more");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(1);
  const sent = (await sentRequests(page)) as unknown as { headers: { items: { name: string; value: string }[] } }[];
  expect(sent[0].headers.items[0]).toMatchObject({ name: "Accept", value: "*/*X-Injected: 1more" });
});

test("hovering a variable in a header value shows its card, with or without an editor", async ({ page }) => {
  await openSection(page, "Headers");
  const cell = valueCell(page, 0);
  await retype(page, cell, "{{baseUrl}} {{token}}");
  await page.keyboard.press("Tab");
  const card = page.locator(".popup-layer .var-card");

  // The static rendering.
  await cell.locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(card).toHaveText(['baseUrlhttp://127.0.0.1:8765from environment "local"Edit']);
  await cell.locator(".cm-var", { hasText: "{{token}}" }).hover();
  await expect(card).toHaveText(['token•••••••• (secret)from environment "local"RevealEdit']);
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // The editor.
  await cell.click();
  await expect(editors(page)).toHaveCount(1);
  await cell.locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(card).toHaveText(['baseUrlhttp://127.0.0.1:8765from environment "local"Edit']);
});
