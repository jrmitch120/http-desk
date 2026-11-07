// The editor's find bar is the app's own (src/lib/codemirror/FindBar.svelte),
// not CodeMirror's default panel: a FilterField-style box, icon buttons, and
// pressed-state toggles instead of native checkboxes.
import { expect, test, type Page } from "@playwright/test";
import { bodyEditor, openApp, openRequest } from "./helpers";

async function openFindInResponse(page: Page): Promise<void> {
  await openApp(page, "?response=bigint");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".body .cm-content")).toContainText('"price": 10.50,');
  await page.getByRole("button", { name: "Search" }).click();
}

const findBar = (page: Page) => page.getByRole("search", { name: "Find in editor" });

test("the find bar is built from the app's controls, with no native checkboxes", async ({ page }) => {
  await openFindInResponse(page);
  const bar = findBar(page);

  await expect(bar.getByRole("textbox", { name: "Find" })).toBeFocused();
  for (const name of ["Previous match", "Next match", "Close find"]) await expect(bar.getByRole("button", { name })).toBeVisible();
  for (const name of ["Match case", "Regular expression", "Whole word"]) {
    await expect(bar.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.locator(".cm-panels input[type=checkbox]")).toHaveCount(0);
  // A read-only response body has nothing to replace.
  await expect(bar.getByRole("textbox", { name: "Replace" })).toHaveCount(0);
});

test("typing finds matches, Enter and the buttons move between them, and toggles narrow them", async ({ page }) => {
  await openFindInResponse(page);
  const bar = findBar(page);
  const field = bar.getByRole("textbox", { name: "Find" });

  await field.fill("PRICE");
  await expect(page.locator(".cm-searchMatch")).not.toHaveCount(0);
  await field.press("Enter");
  await expect(page.locator(".cm-searchMatch-selected")).toHaveCount(1);
  await bar.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator(".cm-searchMatch-selected")).toHaveCount(1);

  const matchCase = bar.getByRole("button", { name: "Match case" });
  await matchCase.click();
  await expect(matchCase).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-searchMatch")).toHaveCount(0);
});

test("an invalid regular expression marks the field invalid and says why", async ({ page }) => {
  await openFindInResponse(page);
  const bar = findBar(page);
  await bar.getByRole("button", { name: "Regular expression" }).click();
  await bar.getByRole("textbox", { name: "Find" }).fill("(");
  const field = bar.getByRole("textbox", { name: "Find" });
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription("Not a valid regular expression");
  await expect(bar.getByRole("alert")).toHaveText("Not a valid regular expression");
});

test("Escape and the close button close the find bar", async ({ page }) => {
  await openFindInResponse(page);
  await page.keyboard.press("Escape");
  await expect(findBar(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Search" }).click();
  await findBar(page).getByRole("button", { name: "Close find" }).click();
  await expect(findBar(page)).toHaveCount(0);
});

test("in an editable body the find bar can replace", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  const editor = bodyEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"a": "cat", "b": "cat"}');
  await page.keyboard.press("ControlOrMeta+F");

  const bar = findBar(page);
  await bar.getByRole("textbox", { name: "Find" }).fill("cat");
  await bar.getByRole("textbox", { name: "Replace" }).fill("dog");
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect(editor).toHaveText('{"a": "dog", "b": "dog"}');
});

test("the find bar stays open and keeps its query when wrap is toggled", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openFindInResponse(page);
  const field = findBar(page).getByRole("textbox", { name: "Find" });
  await field.fill("price");

  await page.getByRole("button", { name: "Wrap lines" }).click();
  await expect(findBar(page).getByRole("textbox", { name: "Find" })).toHaveValue("price");
  await page.getByRole("button", { name: "Wrap lines" }).click();
  await expect(findBar(page).getByRole("textbox", { name: "Find" })).toHaveValue("price");
  expect(errors).toEqual([]);
});
