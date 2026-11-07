// Per-directory environment files (#87, ADR-0004). With `?folderEnvs=1` the mocked
// workspace's api/ folder has env files of its own: `local` with its own baseUrl
// (http://127.0.0.1:9001; the root's private Secret token still applies) and `qa`,
// which only api/ defines. samples/ has none, so it gets the root's local and staging.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

const picker = (page: Page) => page.getByRole("combobox", { name: "Active environment" });
const options = (page: Page) => page.getByRole("listbox", { name: "Active environment" }).getByRole("option");
const strip = (page: Page) => page.getByRole("region", { name: "Pre-send checks" });
const preview = (page: Page) => page.getByRole("region", { name: "Resolved request" });

async function selectEnvironment(page: Page, env: string): Promise<void> {
  await picker(page).click();
  await options(page).filter({ hasText: new RegExp(`^${env}`) }).click();
}

test("a request resolves with its own folder's environment", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.getByRole("switch", { name: "Resolved" }).click();
  await expect(preview(page).locator(".target")).toHaveText("GET http://127.0.0.1:9001/pets?limit=20");
  // The root's Secret token still applies (masked until revealed).
  await preview(page).getByRole("button", { name: "Reveal Secrets" }).click();
  await expect(preview(page).getByRole("group", { name: "Authorization" }).locator(".line")).toHaveText(["Token: dev-token-123"]);

  // Hovering the URL bar's reference shows the same folder's value.
  await page.locator(".url-input .cm-var", { hasText: "{{baseUrl}}" }).hover();
  await expect(page.locator(".var-card .var-card-value")).toHaveText("http://127.0.0.1:9001");
});

test("the picker lists every environment in the workspace and marks those the active request's folder doesn't define", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  await picker(page).click();
  await expect(options(page)).toHaveText(["No environment", "local", "staging", "qanot defined for samples/"]);
  await page.keyboard.press("Escape");

  await openRequest(page, ["api", "pets.http"], "List pets");
  await picker(page).click();
  await expect(options(page)).toHaveText(["No environment", "local", "staging", "qa"]);
});

test("the strip explains when the selected environment isn't defined for the request's folder", async ({ page }) => {
  await openApp(page, "?folderEnvs=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await selectEnvironment(page, "qa");
  // api/ defines qa (without a token, so only that is listed).
  await expect(strip(page).getByRole("listitem")).toHaveText([/token.*is undefined/]);

  await openRequest(page, ["samples", "jetbrains.http"], "Get request with a header");
  const entry = strip(page).getByRole("listitem").first();
  await expect(entry).toContainText("qa isn't defined for samples/, so this request is sent with no environment");
  await entry.getByRole("button", { name: "Choose environment" }).click();
  await expect(page.getByRole("listbox", { name: "Active environment" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("switch", { name: "Resolved" }).click();
  await expect(preview(page)).toContainText("Environment \"qa\" isn't defined for samples/, so it's sent with no environment");

  await selectEnvironment(page, "local");
  await expect(strip(page)).toHaveCount(0);
});
