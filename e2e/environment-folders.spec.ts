// The Environments modal edits one folder's pair of env files at a time (#88, ADR-0004).
// With `?folderEnvs=1` the mocked workspace's api/ has its own env files: `local` with
// its own baseUrl (http://127.0.0.1:9001) and `qa`. The root's private `local` token
// still applies to api/'s requests. samples/ has no env files.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, urlBar } from "./helpers";

const modal = (page: Page) => dialog(page, "Environments");
const folderPicker = (page: Page) => modal(page).getByRole("combobox", { name: "Folder" });
const folderOptions = (page: Page) => page.getByRole("listbox", { name: "Folder" }).getByRole("option");
const card = (page: Page) => page.locator(".popup-layer .var-card");
/** A matrix cell's field: variable `name` in `column` ("Shared" or an environment). */
const cellField = (m: Locator, name: string, column: string) => m.getByRole("textbox", { name: `${name} in ${column}`, exact: true });

async function selectEnvironment(page: Page, env: string): Promise<void> {
  await page.getByRole("combobox", { name: "Active environment" }).click();
  await page.getByRole("listbox", { name: "Active environment" }).getByRole("option").filter({ hasText: new RegExp(`^${env}`) }).click();
}

async function openEnvironments(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Manage environments" }).click();
  return modal(page);
}

test("hover-card Edit opens the folder that supplies the value, on its cell, and Save writes only that folder's files", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await selectEnvironment(page, "local");
  const rootFiles = await mockState(page, "envFiles");

  await urlBar(page).locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(card(page)).toContainText('from environment "local"');
  await card(page).getByRole("button", { name: "Edit" }).click();
  const m = modal(page);
  await expect(folderPicker(page)).toHaveText("api/");
  const field = cellField(m, "baseUrl", "local");
  await expect(field).toBeFocused();
  await expect(field).toHaveText("http://127.0.0.1:9001");

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("http://127.0.0.1:9002");
  await page.keyboard.press("Tab");
  await m.getByRole("button", { name: "Save" }).click();
  await expect(m).toHaveCount(0);

  const api = (await mockState(page, "folderPairs")).api;
  expect(api.environments.find((e) => e.name === "local")?.variables).toEqual([{ name: "baseUrl", value: "http://127.0.0.1:9002", secret: false }]);
  expect(await mockState(page, "envFiles")).toEqual(rootFiles);
  await urlBar(page).locator(".cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(card(page).locator(".var-card-value")).toHaveText("http://127.0.0.1:9002");
});

test("Edit on a value a parent folder supplies opens that folder", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await selectEnvironment(page, "local");
  // The Secret token comes from the root's private file, though api/ defines local too.
  await page.locator(".subtab", { hasText: "Authorization" }).click();
  await page.getByRole("textbox", { name: "Token" }).locator(".cm-var", { hasText: "{{token}}" }).hover();
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(folderPicker(page)).toHaveText("Workspace root");
  await expect(cellField(modal(page), "token", "local")).toBeFocused();
});

test("the strip's Add to environment fix adds it in the folder that supplies the environment", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await selectEnvironment(page, "qa");
  const rootFiles = await mockState(page, "envFiles");
  await page.getByRole("region", { name: "Pre-send checks" }).getByRole("button", { name: "Add token to qa" }).click();

  const m = modal(page);
  await expect(folderPicker(page)).toHaveText("api/");
  await expect(cellField(m, "token", "qa")).toBeFocused();
  await page.keyboard.type("qa-tok");
  await m.getByRole("button", { name: "Save", exact: true }).click();
  await expect(m).toHaveCount(0);
  const qa = (await mockState(page, "folderPairs")).api.environments.find((e) => e.name === "qa");
  expect(qa?.variables.map((v) => [v.name, v.value])).toEqual([
    ["baseUrl", "https://qa.example.com"],
    ["token", "qa-tok"],
  ]);
  expect(await mockState(page, "envFiles")).toEqual(rootFiles);
  await expect(page.getByRole("region", { name: "Pre-send checks" })).toHaveCount(0);
});

test("the modal opens on the active request's nearest folder with env files, and the selector lists every folder", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  let m = await openEnvironments(page);
  await expect(folderPicker(page)).toHaveText("Workspace root");
  await expect(m.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "Environment"]);
  await folderPicker(page).click();
  await expect(folderOptions(page)).toHaveText(["Workspace root", "api/", "samples/Add environment files here…"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(m).toHaveCount(0);

  await openRequest(page, ["api", "pets.http"], "List pets");
  m = await openEnvironments(page);
  await expect(folderPicker(page)).toHaveText("api/");
  // api/'s own pair: no root Shared or staging, no root token.
  await expect(m.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "qa", "Environment"]);
  await expect(m.locator(".kv-row .m-name")).toHaveText(["baseUrl"]);
  await expect(m.getByText("Saved to api/http-client.env.json")).toBeVisible();

  // Switching folders shows that folder's pair.
  await folderPicker(page).click();
  await folderOptions(page).filter({ hasText: /^Workspace root/ }).click();
  await expect(m.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "local", "staging", "Environment"]);
});

test("switching folders with unsaved changes asks first", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  const m = await openEnvironments(page);
  await cellField(m, "baseUrl", "qa").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("https://qa2.example.com");
  await page.keyboard.press("Tab");

  await folderPicker(page).click();
  await folderOptions(page).filter({ hasText: /^Workspace root/ }).click();
  const ask = dialog(page, "Unsaved changes");
  await expect(ask).toContainText("api/");
  await ask.getByRole("button", { name: "Save" }).click();
  await expect(folderPicker(page)).toHaveText("Workspace root");
  const api = (await mockState(page, "folderPairs")).api;
  expect(api.environments.find((e) => e.name === "qa")?.variables[0].value).toBe("https://qa2.example.com");
});

test("environment files can be added to a folder that has none", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  const m = await openEnvironments(page);
  await folderPicker(page).click();
  await folderOptions(page).filter({ hasText: /^samples\// }).click();
  await expect(folderPicker(page)).toHaveText("samples/");
  await expect(m.locator(".kv-head > span")).toHaveText(["Variable", "Shared", "Environment"]);

  await m.getByRole("button", { name: "New environment" }).click();
  await expect(dialog(page, "New environment")).toBeVisible();
  await page.keyboard.type("local");
  await page.keyboard.press("Enter");
  await m.getByRole("button", { name: "Add variable to all environments" }).click();
  await expect(dialog(page, "Add variable to all environments")).toBeVisible();
  await page.keyboard.type("baseUrl");
  await page.keyboard.press("Enter");
  await expect(cellField(m, "baseUrl", "local")).toBeFocused();
  await page.keyboard.type("http://samples.local");
  await page.keyboard.press("Tab");
  await m.getByRole("button", { name: "Save" }).click();
  await expect(m).toHaveCount(0);

  expect((await mockState(page, "folderPairs")).samples.environments).toEqual([
    { name: "local", variables: [{ name: "baseUrl", value: "http://samples.local", secret: false }] },
  ]);
  // samples/'s requests now get its local.
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  await selectEnvironment(page, "local");
  await openEnvironments(page);
  await expect(folderPicker(page)).toHaveText("samples/");
});
