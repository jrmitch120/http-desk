// Linux's Edit menu (#102, ADR-0005). muda's predefined Edit items don't work on
// GTK, so on Linux they're the app's own commands: Cut, Copy, Paste and Select
// All do what the text field's context menu does (src/lib/editMenu.ts), with the
// same greyed-out rules, and Undo and Redo act on the field's history. They act
// on the field that had focus when the menu opened. Menu clicks are the mock's
// `menu` event (`menuClick`), as the shell sends it.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bodyEditor, menuClick, menuItem, openApp, openRequest, searchBox, urlBar } from "./helpers";

test.beforeEach(async ({ page }) => {
  // A clipboard the test controls. The mock's clipboard plugin reads it through navigator.clipboard.
  await page.addInitScript(() => {
    const w = window as unknown as { __clipboard: string };
    w.__clipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (w.__clipboard = text), readText: async () => w.__clipboard },
    });
  });
});

const clipboard = (page: Page) => page.evaluate(() => (window as unknown as { __clipboard: string }).__clipboard);
const setClipboard = (page: Page, text: string) => page.evaluate((t) => ((window as unknown as { __clipboard: string }).__clipboard = t), text);

const EDIT_IDS = ["undo", "redo", "cut", "copy", "paste", "select-all"] as const;

/** Whether each Edit item is enabled now, as the native menu shows it. */
async function editState(page: Page): Promise<Record<string, boolean | undefined>> {
  const entries = await Promise.all(EDIT_IDS.map(async (id) => [id, (await menuItem(page, id))?.enabled] as const));
  return Object.fromEntries(entries);
}

/** The text of an editor (lines joined with newlines), without its placeholder. */
const editorText = (editor: Locator) =>
  editor.evaluate((el) =>
    [...el.querySelectorAll(".cm-line")]
      .map((line) => {
        const copy = line.cloneNode(true) as Element;
        copy.querySelectorAll(".cm-placeholder").forEach((p) => p.remove());
        return copy.textContent;
      })
      .join("\n"),
  );

/** Cut, Copy, Paste and Select All from the menu, in a field that holds `text` and has focus with the caret at its end. */
async function cutCopyPasteSelectAll(page: Page, field: Locator, text: () => Promise<string>) {
  const original = await text();
  expect(original.length).toBeGreaterThan(3);

  await menuClick(page, "select-all");
  await menuClick(page, "copy");
  await expect.poll(() => clipboard(page)).toBe(original);

  await menuClick(page, "cut");
  await expect.poll(text).toBe("");
  expect(await clipboard(page)).toBe(original);

  await menuClick(page, "paste");
  await expect.poll(text).toBe(original);
  await setClipboard(page, "!");
  await menuClick(page, "paste");
  await expect.poll(text).toBe(`${original}!`);
  await expect(field).toBeFocused();
}

test("the Edit menu's Cut, Copy, Paste and Select All work in the URL bar, a value cell and the body editor", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await openRequest(page, ["api", "pets.http"], "List pets");

  await urlBar(page).click();
  await page.keyboard.press("End");
  await cutCopyPasteSelectAll(page, urlBar(page), () => editorText(urlBar(page)));

  await page.locator(".subtab", { hasText: "Headers" }).click();
  const accept = page.locator(".kv-row").first().locator(".c-value");
  await accept.click();
  await page.keyboard.press("End");
  await cutCopyPasteSelectAll(page, accept.locator(".cm-content"), () => editorText(accept.locator(".cm-content")));

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.locator(".subtab", { hasText: "Body" }).click();
  await bodyEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await cutCopyPasteSelectAll(page, bodyEditor(page), () => editorText(bodyEditor(page)));
});

test("the Edit menu's Cut, Copy, Paste and Select All work in a plain input", async ({ page }) => {
  await openApp(page, "?platform=linux");
  const box = searchBox(page);
  await box.fill("pets");
  await cutCopyPasteSelectAll(page, box, () => box.inputValue());
});

test("Undo and Redo undo and redo typing in the body editor and in a plain input", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.locator(".subtab", { hasText: "Body" }).click();
  const body = bodyEditor(page);
  const before = await editorText(body);
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed");
  await expect.poll(() => editorText(body)).toBe(`${before} typed`);

  await expect.poll(() => menuItem(page, "undo")).toMatchObject({ enabled: true });
  await menuClick(page, "undo");
  await expect.poll(() => editorText(body)).toBe(before);
  await menuClick(page, "redo");
  await expect.poll(() => editorText(body)).toBe(`${before} typed`);
  await expect(body).toBeFocused();

  await page.locator(".subtab", { hasText: "Headers" }).click();
  const name = page.locator(".kv-row").first().locator("input.c-name");
  const original = await name.inputValue();
  await name.click();
  await page.keyboard.press("End");
  await page.keyboard.type("-x");
  await expect(name).toHaveValue(`${original}-x`);
  await menuClick(page, "undo");
  await expect(name).toHaveValue(original);
  await menuClick(page, "redo");
  await expect(name).toHaveValue(`${original}-x`);
  await expect(name).toBeFocused();
});

test("the Edit items are greyed out as the context menu's are: read-only text can only be copied and selected", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await openRequest(page, ["api", "pets.http"], "List pets");

  // No text field has focus: nothing applies.
  await page.locator(".subtab", { hasText: "Headers" }).click();
  await expect.poll(() => editState(page)).toEqual({ undo: false, redo: false, cut: false, copy: false, paste: false, "select-all": false });

  // An editable field with nothing selected: nothing to cut or copy.
  await urlBar(page).click();
  await expect.poll(() => editState(page)).toEqual({ undo: true, redo: true, cut: false, copy: false, paste: true, "select-all": true });
  await menuClick(page, "select-all");
  await expect.poll(() => editState(page)).toEqual({ undo: true, redo: true, cut: true, copy: true, paste: true, "select-all": true });

  // The read-only response body: Copy (once something is selected) and Select All only.
  await page.keyboard.press("Control+Enter");
  const response = page.locator(".body .cm-content");
  await response.click();
  await expect.poll(() => editState(page)).toEqual({ undo: false, redo: false, cut: false, copy: false, paste: false, "select-all": true });
  await menuClick(page, "select-all");
  await expect.poll(() => editState(page)).toEqual({ undo: false, redo: false, cut: false, copy: true, paste: false, "select-all": true });
  await menuClick(page, "copy");
  await expect.poll(() => clipboard(page)).toMatch(/^\{\n {2}"items"/);
  // A Cut or Paste that arrives anyway changes nothing.
  await setClipboard(page, "pasted");
  await menuClick(page, "paste");
  await menuClick(page, "cut");
  await page.waitForTimeout(200);
  expect(await editorText(response)).toMatch(/^\{\n {2}"items"/);
});

test("the Edit items stay available under a modal, for its text fields", async ({ page }) => {
  await openApp(page, "?platform=linux");
  await page.keyboard.press("Control+Comma");
  const field = page.getByRole("dialog").getByRole("textbox").first();
  await field.click();
  await expect.poll(() => menuItem(page, "paste")).toMatchObject({ enabled: true });
  expect(await menuItem(page, "settings")).toMatchObject({ enabled: false });
});
