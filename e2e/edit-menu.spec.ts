// The app's own edit menu (#39, ADR-0002): a right-click (or Shift+F10, or the
// Menu key) on any text field opens the app's Menu, never the webview's: Cut,
// Copy, Paste and Select all, disabled where they can't apply, then the
// field's own items (Extract to variable…, Unset in …). Read-only text gets
// Copy and Select all. Anything else shows no menu at all.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bodyEditor, dialog, openApp, openRequest, searchBox, showEnvironmentMatrix, urlBar } from "./helpers";

const EDIT = ["Cut", "Copy", "Paste", "Select all"];
const READ_ONLY = ["Copy", "Select all"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __lastContextMenu: MouseEvent | null; __clipboard: string };
    // The last contextmenu event, to check its default (the webview's menu) was prevented.
    w.__lastContextMenu = null;
    window.addEventListener("contextmenu", (e) => (w.__lastContextMenu = e), true);
    // A clipboard the test controls. The mock's clipboard plugin reads it through navigator.clipboard.
    w.__clipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (w.__clipboard = text), readText: async () => w.__clipboard },
    });
  });
});

const clipboard = (page: Page) => page.evaluate(() => (window as unknown as { __clipboard: string }).__clipboard);
const setClipboard = (page: Page, text: string) => page.evaluate((t) => ((window as unknown as { __clipboard: string }).__clipboard = t), text);
const defaultPrevented = (page: Page) => page.evaluate(() => (window as unknown as { __lastContextMenu: MouseEvent | null }).__lastContextMenu?.defaultPrevented ?? null);
const menuItems = (page: Page) => page.getByRole("menu").getByRole("menuitem");
const item = (page: Page, name: string) => page.getByRole("menu").getByRole("menuitem", { name, exact: true });

/** The menu items that draw an icon (an Icon with a name the set doesn't know draws nothing). */
const withIcons = (page: Page) => menuItems(page).filter({ has: page.locator(".ico svg path:not([d=''])") });

/** Right-clicks `target`: the webview's menu is prevented and the app's shows `items`, each with an icon. Closes it. */
async function expectMenu(page: Page, target: Locator, items: string[]) {
  await target.click({ button: "right" });
  await expect(menuItems(page)).toHaveText(items);
  await expect(withIcons(page)).toHaveText(items);
  expect(await defaultPrevented(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

async function send(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

test("every kind of text field opens the app's edit menu, never the webview's", async ({ page }) => {
  await openApp(page);

  // Nothing editable: no menu at all, and not the webview's either.
  await page.locator(".empty-state").click({ button: "right" });
  expect(await defaultPrevented(page)).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);

  // A plain input.
  await expectMenu(page, searchBox(page), EDIT);

  await openRequest(page, ["api", "pets.http"], "List pets");
  // The URL bar (an editor).
  await expectMenu(page, urlBar(page), EDIT);
  // A variable field, without focus (its static rendering), then with it.
  await page.locator(".subtab", { hasText: "Headers" }).click();
  const accept = page.locator(".kv-row").first().locator(".c-value");
  await expectMenu(page, accept, EDIT);
  await accept.click();
  await expectMenu(page, accept, EDIT);
  // A plain input in a grid, and a textarea (bulk edit).
  await expectMenu(page, page.locator(".kv-row").first().locator("input.c-name"), EDIT);
  await page.getByRole("button", { name: "Bulk edit" }).click();
  await expectMenu(page, page.locator("textarea.bulk-text"), EDIT);
  await page.getByRole("button", { name: "Key-value edit" }).click();

  // The response body is read-only (a JSON one adds Copy path).
  await send(page);
  await expectMenu(page, page.locator(".body .cm-content .cm-line").first(), [...READ_ONLY, "Copy path"]);
  // The .http source is read-only too.
  await page.locator(".btn", { hasText: ".http" }).click();
  await expectMenu(page, page.locator(".source-code .cm-content"), READ_ONLY);

  // The request body editor.
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.locator(".subtab", { hasText: "Body" }).click();
  await expectMenu(page, bodyEditor(page), EDIT);

  // Matrix cells, set (with Unset) or not.
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentMatrix(page);
  const modal = dialog(page, "Environments");
  await expectMenu(page, modal.getByRole("textbox", { name: "baseUrl in local", exact: true }), [...EDIT, "Unset in local"]);
  await expectMenu(page, modal.getByRole("textbox", { name: "token in staging", exact: true }), EDIT);
  await expectMenu(page, modal.getByPlaceholder("Filter variables"), EDIT);
});

test("Cut, Copy, Paste and Select all work in a text input, and are disabled when they can't apply", async ({ page }) => {
  await openApp(page);
  const box = searchBox(page);

  // Nothing selected: nothing to cut or copy.
  await box.click({ button: "right" });
  await expect(item(page, "Cut")).toBeDisabled();
  await expect(item(page, "Copy")).toBeDisabled();
  await setClipboard(page, "pets");
  await item(page, "Paste").click();
  await expect(box).toHaveValue("pets");
  await expect(box).toBeFocused();

  await box.click({ button: "right" });
  await item(page, "Select all").click();
  expect(await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
  await box.click({ button: "right" });
  await item(page, "Copy").click();
  expect(await clipboard(page)).toBe("pets");
  await box.press("End");
  await box.click({ button: "right" });
  await item(page, "Paste").click();
  await expect(box).toHaveValue("petspets");

  await box.press("ControlOrMeta+A");
  await box.click({ button: "right" });
  await item(page, "Cut").click();
  await expect(box).toHaveValue("");
  expect(await clipboard(page)).toBe("petspets");
});

test("in a variable field: Paste keeps it on one line, Copy takes the selection, Extract comes after", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  const accept = page.locator(".kv-row").first().locator(".c-value");

  // Unfocused: Paste lands where the field was clicked (at the end here) and the field keeps its editor.
  await setClipboard(page, ";\n  charset=utf-8");
  const box = (await accept.boundingBox())!;
  await accept.click({ button: "right", position: { x: box.width - 4, y: box.height / 2 } });
  await item(page, "Paste").click();
  await expect(accept).toHaveText("application/json;charset=utf-8");
  await expect(accept.locator(".cm-content")).toBeFocused();

  await page.keyboard.press("ControlOrMeta+A");
  await accept.click({ button: "right" });
  await expect(menuItems(page)).toHaveText([...EDIT, "Extract to variable…"]);
  await expect(withIcons(page)).toHaveText([...EDIT, "Extract to variable…"]);
  await item(page, "Copy").click();
  expect(await clipboard(page)).toBe("application/json;charset=utf-8");

  // A masked field can't be copied from, but can be pasted into.
  await page.locator(".subtab", { hasText: "Authorization" }).click();
  await page.getByRole("combobox", { name: "Authorization type" }).click();
  await page.getByRole("option", { name: "Basic Auth" }).click();
  const password = page.getByRole("textbox", { name: "Password" });
  await setClipboard(page, "hunter2");
  await password.click({ button: "right" });
  await item(page, "Paste").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("textbox", { name: "Password" }).click({ button: "right" });
  await expect(menuItems(page)).toHaveText(EDIT);
  await expect(item(page, "Cut")).toBeDisabled();
  await expect(item(page, "Copy")).toBeDisabled();
  await expect(item(page, "Paste")).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Password" })).toHaveText("hunter2");
});

test("Select all and Copy in the read-only response body", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  const body = page.locator(".body .cm-content");
  await body.click({ button: "right" });
  await expect(item(page, "Copy")).toBeDisabled();
  await item(page, "Select all").click();
  await body.click({ button: "right", position: { x: 20, y: 8 } });
  await item(page, "Copy").click();
  expect(await clipboard(page)).toMatch(/^\{\n {2}"items"/);
});

test("Shift+F10 and the Menu key open the edit menu from the keyboard", async ({ page }) => {
  await openApp(page);
  await searchBox(page).click();
  await page.keyboard.type("abc");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Shift+F10");
  await expect(menuItems(page)).toHaveText(EDIT);
  await expect(item(page, "Cut")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.press("Backspace"); // the search would hide the tree

  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("ContextMenu");
  await expect(menuItems(page)).toHaveText(EDIT);
  // Nothing is selected, so it opens on Paste.
  await expect(item(page, "Paste")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Select all")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("{{baseUrl}}/pets?limit=20");
});
