import { expect, test, type Locator } from "@playwright/test";
import { activeTab, bodyEditor, openApp, openRequest, sentRequests, urlBar } from "./helpers";

test("⌘Enter in a JSON body sends once without editing the body", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await page.getByRole("button", { name: "Body" }).click();
  const body = bodyEditor(page);
  const lines = body.locator(".cm-line");
  const before = await lines.allTextContents();
  await body.click();
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(page.getByText("201 Created")).toBeVisible();
  expect(await sentRequests(page)).toHaveLength(1);
  await expect(lines).toHaveText(before);
  await expect(activeTab(page).locator(".dot")).toHaveCount(0);
});

test("⌘, with the Environments editor open and edited keeps the editor and its edits", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+E");
  const envs = page.getByRole("dialog", { name: "Environments" });
  await envs.getByPlaceholder("Add variable").fill("apiKey");
  await page.keyboard.press("ControlOrMeta+Comma");

  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(envs).toBeVisible();
  await expect.poll(() => inputValues(envs)).toContain("apiKey");
});

test("with a confirm dialog open, ⌘S, ⌘Enter and ⌘T do nothing", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("&page=2");
  await activeTab(page).getByRole("button", { name: "Close" }).click();
  const confirm = page.getByRole("dialog", { name: 'Save changes to "List pets"?' });
  await expect(confirm).toBeVisible();

  for (const key of ["ControlOrMeta+S", "ControlOrMeta+Enter", "ControlOrMeta+T"]) await page.keyboard.press(key);
  await page.keyboard.press("Escape");

  await expect(confirm).toHaveCount(0);
  await expect(page.locator(".tabbar .tab")).toHaveCount(1);
  await expect(activeTab(page).locator(".dot")).toHaveCount(1);
  expect(await sentRequests(page)).toHaveLength(0);
});

test("Escape closes only the topmost dialog, leaving the modal under it open", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+E");
  const envs = page.getByRole("dialog", { name: "Environments" });
  await envs.getByPlaceholder("Add variable").fill("apiKey");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(discard).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(discard).toHaveCount(0);
  await expect(envs).toBeVisible();
  await expect.poll(() => inputValues(envs)).toContain("apiKey");

  await page.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(envs).toHaveCount(0);
});

function inputValues(scope: Locator): Promise<string[]> {
  return scope.locator("input").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}
