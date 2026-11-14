// #142: scripts referenced by file (`> check.js`, `< sign.js`) run like inline
// ones, read next to the `.http` file and only from inside the workspace; the
// Scripts editor shows a file reference's path with "Open in default editor", or
// why it can't run. JetBrains `>> file` redirects are kept but never run, and the
// request says so. `?scriptFiles=1` gives pets.http's List pets `> ./check-status.js`
// (a file the mock workspace has) and Create pet `< ./missing.js` and
// `> ../../outside.js`. `?trusted=1` starts trusted.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest } from "./helpers";

const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const scripts = (page: Page) => page.getByRole("group", { name: "Scripts" });
const script = (page: Page, name: string) => scripts(page).getByRole("group", { name });
const REDIRECT_NOTE = "HttpDesk doesn't run response redirects: >> response.json doesn't save the response to a file.";

async function openSettings(page: Page, file: string[], name: string) {
  await openRequest(page, file, name);
  await page.locator(".subtab", { hasText: "Settings" }).click();
}

test("a handler in a .js file next to the .http file runs and its tests show", async ({ page }) => {
  await openApp(page, "?scriptFiles=1&trusted=1");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await page.getByRole("radiogroup", { name: "Response tabs" }).getByRole("radio", { name: /^Tests\b/ }).click();
  await expect(page.getByTestId("test-result")).toContainText("Status is 200");
  await expect(page.getByTestId("test-result").getByLabel("Passed")).toBeVisible();
});

test("a file reference shows its path, and Open in default editor opens the file", async ({ page }) => {
  await openApp(page, "?scriptFiles=1");
  await openSettings(page, ["api", "pets.http"], "List pets");
  const handler = script(page, "Response handler");
  await expect(handler.locator("code")).toHaveText("./check-status.js");
  // Only inline scripts are edited here.
  await expect(handler.locator(".cm-content")).toHaveCount(0);
  await handler.getByRole("button", { name: "Open in default editor" }).click();
  await expect.poll(() => mockState(page, "openedPaths")).toEqual(["/demo/api/check-status.js"]);
});

test("a missing file and one outside the workspace show why, can't be opened, and a missing pre-request script blocks the send", async ({ page }) => {
  await openApp(page, "?scriptFiles=1&trusted=1");
  await openSettings(page, ["api", "pets.http"], "Create pet");
  const pre = script(page, "Pre-request script");
  const handler = script(page, "Response handler");
  await expect(pre.getByRole("status")).toContainText("Script file ./missing.js doesn't exist");
  await expect(handler.getByRole("status")).toContainText("Script file ../../outside.js is outside the workspace");
  await expect(scripts(page).getByRole("button", { name: "Open in default editor" })).toHaveCount(0);

  await send(page);
  const panel = page.locator(".send-error");
  await expect(panel).toContainText("Pre-request script failed");
  await expect(panel).toContainText("Script file ./missing.js doesn't exist");
});

test("a request with >> response.json sends normally, saves no file and shows the note", async ({ page }) => {
  await openApp(page);
  await openSettings(page, ["samples", "jetbrains.http"], "Send a form with the text and file fields");
  const redirect = script(page, "Response redirect");
  await expect(redirect.locator("code")).toHaveText(">> response.json");
  await expect(redirect).toContainText("HttpDesk doesn't run it, so the response isn't saved to a file.");

  await send(page);
  await expect(page.getByText(REDIRECT_NOTE)).toBeVisible();
  expect(await mockState(page, "savedBodies")).toEqual({});
});
