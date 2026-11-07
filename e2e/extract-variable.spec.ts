// Extract to variable (#85): selected text in the URL bar or a variable-aware
// field becomes `{{name}}`, and `name` is defined as a File variable, in the
// selected environment or in every environment.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTab, dialog, mockState, openApp, openRequest, urlBar } from "./helpers";

const HOST = "https://example.com";

/** Opens jetbrains.http's "Multi-line query" (GET https://example.com/comments?page=2&pageSize=10) and selects its host. */
async function selectHost(page: Page): Promise<void> {
  await openApp(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Multi-line query");
  await selectFromStart(page, urlBar(page), HOST.length);
}

/** Puts the caret at the start of an editor and selects `n` characters. */
async function selectFromStart(page: Page, editor: Locator, n: number): Promise<void> {
  await editor.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < n; i++) await page.keyboard.press("Shift+ArrowRight");
}

/** Right-clicks the middle of the selection drawn in `field`. */
async function rightClickSelection(page: Page, field: Locator): Promise<void> {
  const box = (await field.locator(".cm-selectionBackground").first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
}

/** The names in a grid, in order. */
const names = (grid: Locator) => grid.locator(".kv-row:not(.ghost) input.c-name").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const form = (page: Page) => dialog(page, "Extract to variable");
const destination = (page: Page, name: string) => form(page).getByRole("radiogroup", { name: "Add to" }).getByRole("radio", { name });

test("the URL bar's context menu extracts the host into a File variable, as an unsaved edit", async ({ page }) => {
  await selectHost(page);
  await rightClickSelection(page, page.locator(".url-input"));
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Cut", "Copy", "Paste", "Select all", "Extract to variable…"]);
  await page.getByRole("menuitem", { name: "Extract to variable…" }).click();

  await expect(form(page).getByText(HOST, { exact: true })).toBeVisible();
  await expect(destination(page, "File variable")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.type("exampleHost");
  await page.keyboard.press("Enter");

  await expect(form(page)).toBeHidden();
  await expect(urlBar(page)).toHaveText("{{exampleHost}}/comments?page=2&pageSize=10");
  await expect(urlBar(page)).toBeFocused();
  await expect(urlBar(page).locator(".cm-var-ok")).toHaveText("{{exampleHost}}");
  await expect(activeTab(page).locator(".dot")).toBeVisible();

  await page.locator(".subtab", { hasText: "Settings" }).click();
  const grid = page.getByRole("group", { name: "File variables" });
  await expect.poll(() => names(grid)).toEqual(["host", "userId", "exampleHost"]);
  await expect(grid.locator(".kv-row").nth(2).locator(".c-value")).toHaveText(HOST);
});

test("⌘/Ctrl+Alt+V extracts into every environment, written to the env file at once", async ({ page }) => {
  await selectHost(page);
  await page.keyboard.press("ControlOrMeta+Alt+KeyV");
  await page.keyboard.type("exampleHost");
  await destination(page, "All environments").click();
  await form(page).getByRole("button", { name: "Extract" }).click();

  await expect(urlBar(page)).toHaveText("{{exampleHost}}/comments?page=2&pageSize=10");
  const shared = (await mockState(page, "envFiles")).shared;
  expect(shared.local.exampleHost).toBe(HOST);
  expect(shared.staging.exampleHost).toBe(HOST);
  await expect(page.getByText("Added exampleHost to every environment")).toBeVisible();
  // The selected environment (local) now defines it.
  await expect(urlBar(page).locator(".cm-var-ok")).toHaveText("{{exampleHost}}");
});

test("the form checks the name and warns when the destination already has it", async ({ page }) => {
  await selectHost(page);
  await page.keyboard.press("ControlOrMeta+Alt+KeyV");
  const name = form(page).getByLabel("Name", { exact: true });
  const extract = form(page).getByRole("button", { name: "Extract" });
  await expect(extract).toBeDisabled();

  await name.fill("base url");
  await expect(form(page).getByRole("alert")).toHaveText("Variable names can only use letters, digits, _, -, . and $");
  await expect(extract).toBeDisabled();

  // jetbrains.http declares @host; local and staging both define baseUrl.
  await name.fill("host");
  await expect(form(page).getByRole("status")).toHaveText("host is already a File variable; its value will be replaced.");
  await destination(page, 'Environment "local"').click();
  await expect(form(page).getByRole("status")).toHaveCount(0);
  await name.fill("baseUrl");
  await expect(form(page).getByRole("status")).toHaveText("local already has baseUrl; its value will be replaced.");
  await destination(page, "All environments").click();
  await expect(form(page).getByRole("status")).toHaveText("local and staging already have baseUrl; their values will be replaced.");
  await expect(extract).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(form(page)).toBeHidden();
  await expect(urlBar(page)).toHaveText(`${HOST}/comments?page=2&pageSize=10`);
});

test("works in a variable-aware field: a File variable's value, with the request's Settings open", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Multi-line query");
  await page.locator(".subtab", { hasText: "Settings" }).click();
  const grid = page.getByRole("group", { name: "File variables" });
  const host = grid.locator(".kv-row").first().locator(".c-value");
  await host.click();
  await page.keyboard.press("End");
  for (let i = 0; i < "httpbin.org".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await rightClickSelection(page, host);
  await page.getByRole("menuitem", { name: "Extract to variable…" }).click();
  await page.keyboard.type("domain");
  await page.keyboard.press("Enter");

  await expect(host).toHaveText("https://{{domain}}");
  await expect.poll(() => names(grid)).toEqual(["host", "userId", "domain"]);
  await expect(grid.locator(".kv-row").nth(2).locator(".c-value")).toHaveText("httpbin.org");
  // Editing the grid afterwards keeps the new variable.
  await page.keyboard.press("End");
  await page.keyboard.type("/");
  await page.keyboard.press("Tab");
  await expect.poll(() => names(grid)).toEqual(["host", "userId", "domain"]);
});

test("works in a header value with the shortcut, into the selected environment", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  await page.locator(".subtab", { hasText: "Headers" }).click();
  const accept = page.locator(".kv-row").first().locator(".c-value");
  await accept.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+Alt+KeyV");
  await page.keyboard.type("accept");
  await destination(page, 'Environment "local"').click();
  await form(page).getByRole("button", { name: "Extract" }).click();

  await expect(accept).toHaveText("{{accept}}");
  await expect(accept.locator(".cm-var-ok")).toHaveText("{{accept}}");
  const files = await mockState(page, "envFiles");
  expect(files.shared.local.accept).toBe("application/json");
  expect(files.shared.staging.accept).toBeUndefined();
  await expect(activeTab(page).locator(".dot")).toBeVisible();
});

test("a masked field offers no extraction, nor does the menu without a selection", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: "Authorization" }).click();
  await page.getByRole("combobox", { name: "Authorization type" }).click();
  await page.getByRole("option", { name: "Basic Auth" }).click();
  const password = page.getByRole("textbox", { name: "Password" });
  await password.click();
  await page.keyboard.type("hunter2");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+Alt+KeyV");
  await expect(form(page)).toHaveCount(0);
  await password.click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Cut", "Copy", "Paste", "Select all"]);
  await page.keyboard.press("Escape");

  await urlBar(page).click();
  await urlBar(page).click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Cut", "Copy", "Paste", "Select all"]);
});
