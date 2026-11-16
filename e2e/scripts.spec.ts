// #137: JetBrains response handlers run after a send, only in a Trusted workspace,
// and their client.test/client.assert results show in a Tests tab. The mocked
// sample `samples/jetbrains.http` "Post with JSON body" has a handler testing
// `response.status === 200`; the mock answers a POST with 201 (so it fails)
// unless `?status=200`. `?trusted=1` starts with the demo workspace trusted.
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, sentRequests } from "./helpers";

const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const trustPrompt = (page: Page) => dialog(page, "Run this workspace's scripts?");
const viewerTabs = (page: Page) => page.getByRole("radiogroup", { name: "Response tabs" });
const testsTab = (page: Page) => viewerTabs(page).getByRole("radio", { name: /^Tests\b/ });
const results = (page: Page) => page.getByTestId("test-result");
const openHandler = (page: Page) => openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");

test("an untrusted workspace asks before running a handler; Cancel sends nothing", async ({ page }) => {
  await openApp(page);
  await openHandler(page);
  await send(page);
  const prompt = trustPrompt(page);
  await expect(prompt).toContainText("/demo");
  for (const name of ["Cancel", "Send without scripts", "Trust and run"]) {
    await expect(prompt.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(prompt.getByRole("button", { name: "Cancel" })).toBeFocused();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toBeHidden();
  expect(await sentRequests(page)).toEqual([]);
});

test("Send without scripts sends without the handler, says so, and doesn't ask again", async ({ page }) => {
  await openApp(page);
  await openHandler(page);
  await send(page);
  await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
  await expect(page.getByText("Sent without scripts: the response handler didn't run.")).toBeVisible();
  await expect(testsTab(page)).toHaveCount(0);
  await send(page);
  await expect.poll(() => mockState(page, "sentSkipScripts")).toEqual([true, true]);
  await expect(trustPrompt(page)).toBeHidden();
  expect((await mockState(page, "settings")).trustedWorkspaces).toEqual([]);
});

test("Trust and run shows each test with its name, pass or fail and message, and is remembered across restarts", async ({ page }) => {
  await openApp(page);
  await openHandler(page);
  await send(page);
  await trustPrompt(page).getByRole("button", { name: "Trust and run" }).click();
  await testsTab(page).click();
  await expect(results(page)).toHaveCount(1);
  await expect(results(page)).toContainText("Request executed successfully");
  await expect(results(page)).toContainText("Response status is not 200");
  await expect(results(page).getByLabel("Failed")).toBeVisible();
  await expect(page.getByText("1 failed")).toBeVisible();

  // A restart keeps the trust: no question this time.
  await page.reload();
  await expect(page.getByRole("treeitem").first()).toBeVisible();
  await openHandler(page);
  await send(page);
  await expect(testsTab(page)).toBeVisible();
  await expect(trustPrompt(page)).toBeHidden();
  expect(await mockState(page, "sentSkipScripts")).toEqual([false]);
});

test("passing tests show as passed", async ({ page }) => {
  await openApp(page, "?trusted=1&status=200");
  await openHandler(page);
  await send(page);
  await testsTab(page).click();
  await expect(results(page).getByLabel("Passed")).toBeVisible();
  await expect(page.getByText("1 passed")).toBeVisible();
});

test("a request without a handler has no Tests tab and never asks", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect(viewerTabs(page).getByRole("radio")).toHaveText([/^Body/, /^Headers/, /^Cookies/, /^Timing/, /^Request/]);
  await expect(trustPrompt(page)).toBeHidden();
});

test("Settings lists Trusted workspaces and revoking one asks again on the next send", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = dialog(page, "Settings");
  const row = settings.getByTestId("trusted-workspace");
  await expect(row).toContainText("/demo");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  await expect(settings.getByText("No workspace is trusted yet.")).toBeVisible();
  expect((await mockState(page, "settings")).trustedWorkspaces).toEqual([]);
  await settings.getByRole("button", { name: "Done" }).click();

  await openHandler(page);
  await send(page);
  await expect(trustPrompt(page)).toBeVisible();
});
