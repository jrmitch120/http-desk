// Variable-aware fields beyond params and headers (#80): Authorization, form and
// multipart values, File variables and the Environments modal all highlight
// {{variables}}, show the hover card and autocomplete them.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp, openRequest, sentRequests, showEnvironmentList } from "./helpers";

/** Opens List pets (the `local` environment is selected: baseUrl, Secret token; shared: version). */
async function openSection(page: Page, section: "Authorization" | "Body" | "Settings"): Promise<void> {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.locator(".subtab", { hasText: section }).click();
}

async function authKind(page: Page, kind: "Basic Auth" | "Bearer Token" | "API Key"): Promise<void> {
  await page.getByRole("combobox", { name: "Authorization type" }).click();
  await page.getByRole("option", { name: kind }).click();
}

/** The variable-aware field named `name`, whether it has an editor or not. */
const field = (page: Page, name: string): Locator => page.locator(".var-field").filter({ has: page.getByRole("textbox", { name, exact: true }) });

/** Replaces a field's text by typing. */
async function retype(page: Page, field: Locator, text: string): Promise<void> {
  await field.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

const card = (page: Page): Locator => page.locator(".popup-layer .var-card");
const completions = (page: Page): Locator => page.locator(".popup-layer .cm-tooltip-autocomplete");

/** Accepts the selected completion (CodeMirror ignores Enter for 75 ms after the list opens). */
async function accept(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(completions(page)).toBeHidden({ timeout: 200 });
  }).toPass();
}

test("an API key value highlights variables and shows their cards", async ({ page }) => {
  await openSection(page, "Authorization");
  await authKind(page, "API Key");
  const value = field(page, "Value");
  await retype(page, value, "{{token}}-{{nope}}");
  await page.keyboard.press("Tab");

  await expect(value).toHaveText("{{token}}-{{nope}}");
  await expect(value.locator(".cm-var-ok.cm-var-secret")).toHaveText("{{token}}");
  await expect(value.locator(".cm-var-bad")).toHaveText("{{nope}}");
  await value.locator(".cm-var", { hasText: "{{token}}" }).hover();
  await expect(card(page)).toHaveText(['token•••••••• (secret)from environment "local"RevealEdit']);
});

test("a Basic auth password stays masked, and its variables show only once revealed", async ({ page }) => {
  await openSection(page, "Authorization");
  await authKind(page, "Basic Auth");
  const username = field(page, "Username");
  await retype(page, username, "{{version}}");
  await expect(username.locator(".cm-var-ok")).toHaveText("{{version}}");

  const password = field(page, "Password");
  await retype(page, password, "pw{{token}}");
  // While editing, the text is drawn as discs and nothing is marked.
  await expect(password.locator(".cm-content")).toHaveCSS("-webkit-text-security", "disc");
  await expect(password.locator(".cm-var")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(password).toHaveText("•••••••••••");
  await expect(password.locator(".cm-var")).toHaveCount(0);

  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(password).toHaveText("pw{{token}}");
  await expect(password.locator(".cm-var-secret")).toHaveText("{{token}}");
});

test("typing {{ in a form field value opens variable autocomplete", async ({ page }) => {
  await openSection(page, "Body");
  await page.getByRole("radiogroup", { name: "Body type" }).getByRole("radio", { name: "x-www-form-urlencoded", exact: true }).click();
  const grid = page.getByRole("group", { name: "Form fields" });
  await grid.getByPlaceholder("Add key").click();
  await page.keyboard.type("q");
  await page.keyboard.press("Tab");
  await page.keyboard.type("{{ba");

  await expect(completions(page)).toBeVisible();
  await expect(completions(page).getByRole("option").first()).toHaveText(/^baseUrl/);
  await accept(page);
  const value = grid.locator(".kv-row").first().locator(".c-value");
  await expect(value).toHaveText("{{baseUrl}}");
  await expect(value.locator(".cm-var-ok")).toHaveText("{{baseUrl}}");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(1);
  const sent = (await sentRequests(page)) as unknown as { body: { text: string } }[];
  expect(sent[0].body.text).toBe("q={{baseUrl}}");
});

test("multipart text values and file paths highlight variables", async ({ page }) => {
  // Wide enough for a file part's value column to hold its path next to Choose…
  await page.setViewportSize({ width: 1800, height: 720 });
  await openSection(page, "Body");
  await page.getByRole("radiogroup", { name: "Body type" }).getByRole("radio", { name: "form-data", exact: true }).click();
  const grid = page.getByRole("group", { name: "Form-data parts" });
  await grid.getByPlaceholder("Add key").click();
  await page.keyboard.type("note");
  const row = grid.locator(".kv-row").first();
  await row.locator(".c-value").click();
  await page.keyboard.type("v{{version}}");
  await page.keyboard.press("Tab");
  await expect(row.locator(".c-value .cm-var-ok")).toHaveText("{{version}}");

  await row.getByRole("combobox", { name: "Type of note" }).click();
  await page.getByRole("option", { name: "File" }).click();
  await row.getByRole("textbox", { name: "File path" }).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("./{{nope}}.png");
  await page.keyboard.press("Tab");
  await expect(row.locator(".c-value .cm-var-bad")).toHaveText("{{nope}}");
});

test("a File variable's value resolves the variables it refers to", async ({ page }) => {
  await openSection(page, "Settings");
  const grid = page.getByRole("group", { name: "File variables" });
  // pets.http declares @petId = 1.
  for (const [name, value] of [
    ["api", "{{baseUrl}}/v1"],
    ["pet", "{{api}}/pets/{{petId}}"],
  ]) {
    await grid.getByPlaceholder("Add variable").click();
    await page.keyboard.type(name);
    await page.keyboard.press("Tab");
    await page.keyboard.type(value);
  }
  await page.keyboard.press("Tab");

  const pet = grid.locator(".kv-row").nth(2).locator(".c-value");
  await expect(pet.locator(".cm-var-ok")).toHaveText(["{{api}}", "{{petId}}"]);
  await pet.locator(".cm-var", { hasText: "{{api}}" }).hover();
  await expect(card(page)).toHaveText(["apihttp://127.0.0.1:8765/v1from this fileEdit"]);
});

/** Opens the Environments list on `env` and returns its variable grid. */
async function environment(page: Page, env: string): Promise<Locator> {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentList(page);
  const dialog = page.getByRole("dialog", { name: "Environments" });
  await dialog.locator(".env").filter({ has: page.getByText(env, { exact: true }) }).click();
  return dialog.getByRole("group", { name: "Variables" });
}

/** Types a variable into the grid's ghost row. */
async function addVariable(page: Page, grid: Locator, name: string, value: string): Promise<void> {
  await grid.getByPlaceholder("Add variable").click();
  await page.keyboard.type(name);
  await page.keyboard.press("Tab");
  await page.keyboard.type(value);
}

test("an environment's values see that environment and the shared variables, whichever is active", async ({ page }) => {
  // `local` is active; `staging` has its own baseUrl and no token.
  const grid = await environment(page, "staging");
  await addVariable(page, grid, "host", "example.org");
  await addVariable(page, grid, "api", "https://{{host}}/{{version}}");
  await addVariable(page, grid, "url", "{{");

  const options = completions(page).getByRole("option");
  await expect(completions(page)).toBeVisible();
  await expect(options.filter({ hasText: /^baseUrl/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^version/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^api/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^token/ })).toHaveCount(0);

  // Escape closes the list, not the modal.
  await page.keyboard.press("Escape");
  await expect(completions(page)).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Environments" })).toBeVisible();

  await page.keyboard.type("api}} {{baseUrl}}");
  await page.keyboard.press("Tab");
  const url = grid.locator(".kv-row").nth(3).locator(".c-value");
  await expect(url).toHaveText("{{api}} {{baseUrl}}");
  await url.locator(".cm-var", { hasText: "{{api}}" }).hover();
  await expect(card(page)).toHaveText(['apihttps://example.org/v1from environment "staging"Edit']);
  await url.locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(card(page)).toHaveText(['baseUrlhttps://staging.example.comfrom environment "staging"Edit']);

  // Edit stays in the modal: a shared variable's card shows the shared variables, on its row.
  await page.mouse.move(0, 0);
  await expect(card(page)).toHaveCount(0);
  await grid.locator(".kv-row").nth(2).locator(".c-value .cm-var", { hasText: "{{version}}" }).hover();
  await expect(card(page)).toContainText("from shared");
  await card(page).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Environments" });
  await expect(dialog.locator(".main-head .title")).toContainText("Shared variables");
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator(":focus").locator("xpath=ancestor::*[contains(@class,'kv-row')]").locator("input.c-name")).toHaveValue("version");
});

test("a Secret's value stays masked, marks included, until it is shown", async ({ page }) => {
  const grid = await environment(page, "local");
  const row = grid.locator(".kv-row").nth(1);
  await expect(row.locator("input.c-name")).toHaveValue("token");
  const value = row.locator(".c-value .var-field");
  await expect(value).toHaveText("•••••••••••••");

  await value.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("{{baseUrl}}-x");
  await expect(value.locator(".cm-content")).toHaveCSS("-webkit-text-security", "disc");
  await expect(value.locator(".cm-var")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(value).toHaveText("•••••••••••••");
  await expect(value.locator(".cm-var")).toHaveCount(0);

  await row.getByRole("button", { name: "Show value" }).click();
  await expect(value).toHaveText("{{baseUrl}}-x");
  await expect(value.locator(".cm-var-ok")).toHaveText("{{baseUrl}}");
});

test("Escape in a value with its text selected closes the Environments modal, as in a text input", async ({ page }) => {
  const grid = await environment(page, "local");
  await grid.locator("input.c-name").first().click();
  await page.keyboard.press("Tab");
  await expect(grid.locator(".kv-row").first().locator(".c-value .cm-content")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Environments" })).toBeHidden();
});
