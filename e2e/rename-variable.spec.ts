// Rename variable (#86): a matrix row's "Rename…" renames the variable in every
// environment and, optionally, every `{{name}}` reference Find usages finds. Files
// without unsaved edits are saved at once; one with unsaved edits gets the rename
// in memory and stays unsaved. The mock has `local` (baseUrl, Secret token) and
// `staging` (baseUrl); pets.http and jetbrains.http each use `{{token}}` in one
// request's auth.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, showEnvironmentMatrix, tab, urlBar } from "./helpers";

const PETS = "/demo/api/pets.http";
const JETBRAINS = "/demo/samples/jetbrains.http";

/** Opens the Environments modal on the matrix and picks "Rename…" from variable `name`'s row actions. */
async function startRename(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentMatrix(page);
  const matrix = dialog(page, "Environments").getByRole("group", { name: "Environments matrix" });
  await matrix.locator(".kv-row").filter({ hasText: name }).getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const form = dialog(page, "Rename variable");
  await expect(form).toBeVisible();
  return form;
}

test("refuses a name that exists, and without Update references changes only the env files", async ({ page }) => {
  await openApp(page);
  const filesBefore = await mockState(page, "files");
  const form = await startRename(page, "baseUrl");
  const name = form.getByLabel("New name");
  await expect(name).toHaveValue("baseUrl");
  await expect(name).toBeFocused();

  await name.fill("token");
  await expect(form.getByRole("alert")).toHaveText("local already has a variable named token");
  await expect(form.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();

  await name.fill("apiUrl");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await form.getByRole("checkbox", { name: "Update references" }).click();
  await expect(form.getByRole("list", { name: "Files to update" })).toHaveCount(0);
  await form.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(form).toHaveCount(0);

  const envFiles = await mockState(page, "envFiles");
  expect(envFiles.shared.local).toEqual({ apiUrl: "http://127.0.0.1:8765" });
  expect(envFiles.shared.staging).toEqual({ apiUrl: "https://staging.example.com" });
  expect(await mockState(page, "files")).toEqual(filesBefore);
  // The Environments modal shows the new name, saved.
  const modal = dialog(page, "Environments");
  await expect(modal.locator(".kv-row .m-name")).toHaveText(["apiUrl", "token", "version"]);
  await expect(modal.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("renaming across two files saves the one without unsaved edits and leaves the other unsaved", async ({ page }) => {
  await openApp(page);
  const before = (await mockState(page, "files")) as unknown as Record<string, { requests: Record<string, unknown>[] }>;
  // pets.http has an unsaved edit.
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?limit=5");
  await expect(tab(page, "List pets").locator(".dot")).toBeVisible();

  const form = await startRename(page, "token");
  // The preview lists each file with how many of its requests change.
  const preview = form.getByRole("list", { name: "Files to update" });
  await expect(preview.getByRole("listitem")).toHaveText([/api\/pets\.http\s*1 request/, /samples\/jetbrains\.http\s*1 request/]);
  await form.getByLabel("New name").fill("apiToken");
  await form.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(form).toHaveCount(0);

  // The Secret is renamed and stays in the private file.
  const envFiles = await mockState(page, "envFiles");
  expect(envFiles.private.local).toEqual({ apiToken: "dev-token-123" });
  expect(envFiles.shared.local).toEqual({ baseUrl: "http://127.0.0.1:8765" });

  // jetbrains.http wasn't open: saved, with only the request that used it changed.
  const after = (await mockState(page, "files")) as unknown as Record<string, { requests: Record<string, unknown>[] }>;
  const saved = after[JETBRAINS].requests;
  expect((saved[1].auth as { token: string }).token).toBe("{{apiToken}}");
  const others = (reqs: Record<string, unknown>[]) => reqs.filter((_, i) => i !== 1).map(({ _key, ...r }) => r); // _key: frontend-only
  expect(others(saved)).toEqual(others(before[JETBRAINS].requests));

  // pets.http had unsaved edits: renamed on screen, not saved.
  expect(after[PETS]).toEqual(before[PETS]);
  await page.keyboard.press("Escape");
  await expect(dialog(page, "Environments")).toHaveCount(0);
  await expect(tab(page, "List pets").locator(".dot")).toBeVisible();
  await page.locator(".subtab", { hasText: "Auth" }).click();
  await expect(page.getByRole("textbox", { name: "Token" })).toHaveText("{{apiToken}}");
  await expect(page.getByText("pets.http had unsaved edits, so it was left unsaved.")).toBeVisible();
});

test("with unsaved environment changes, Rename asks to save them first", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  await showEnvironmentMatrix(page);
  const modal = dialog(page, "Environments");
  await page.getByRole("textbox", { name: "baseUrl in staging", exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type("/v2");
  await page.keyboard.press("Tab");
  await modal.locator(".kv-row").filter({ hasText: "baseUrl" }).getByRole("button", { name: "Actions for baseUrl" }).click();
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();

  const ask = dialog(page, "Save changes first?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page, "Rename variable")).toHaveCount(0);

  await modal.locator(".kv-row").filter({ hasText: "baseUrl" }).getByRole("button", { name: "Actions for baseUrl" }).click();
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  await dialog(page, "Save changes first?").getByRole("button", { name: "Save" }).click();
  const form = dialog(page, "Rename variable");
  await expect(form).toBeVisible();
  expect((await mockState(page, "envFiles")).shared.staging).toEqual({ baseUrl: "https://staging.example.com/v2" });
  // Escape closes the form only.
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(modal).toBeVisible();
});
