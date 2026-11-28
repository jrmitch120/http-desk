// Every text field the app draws turns off the OS's autocomplete, autocorrect,
// autocapitalize and spell-check (src/lib/textField.ts): on macOS, WebKit otherwise
// offers text-replacement bubbles in fields that hold paths, URLs and code. This
// checks what actually renders, CodeMirror editors (contenteditable) included.
import { expect, test, type Page } from "@playwright/test";
import { dialog, openApp, openRequest, showSettingsPage } from "./helpers";

/** Every text field on the page whose attributes say the OS may change what's typed. */
function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]')]
      .filter((el) => !(el instanceof HTMLInputElement) || ["text", "password", "search", ""].includes(el.type))
      .filter(
        (el) =>
          el.getAttribute("autocorrect") !== "off" ||
          el.getAttribute("autocapitalize") !== "off" ||
          el.getAttribute("spellcheck") !== "false" ||
          (!el.isContentEditable && el.getAttribute("autocomplete") !== "off"),
      )
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${el.getAttribute("aria-label") ?? ""}"`),
  );
}

test("the request editor's fields and editors don't autocorrect", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
  expect(await offenders(page)).toEqual([]);
});

test("Settings' fields don't autocorrect", async ({ page }) => {
  await openApp(page);
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  for (const category of ["Requests", "TLS", "History"]) {
    await showSettingsPage(page, category);
    expect(await offenders(page), category).toEqual([]);
  }
  await expect(dialog(page, "Settings")).toBeVisible();
});
