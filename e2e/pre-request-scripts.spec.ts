// #140: JetBrains pre-request scripts (`< {% %}`) run before the request is
// built, only in a Trusted workspace. `?preScript=sign|fail` gives pets.http's
// List pets a pre-request script; the mock fails a send whose script throws,
// like the shell, with the script's line. `?trusted=1` starts trusted.
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, sentRequests } from "./helpers";

const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const trustPrompt = (page: Page) => dialog(page, "Run this workspace's scripts?");
const openListPets = (page: Page) => openRequest(page, ["api", "pets.http"], "List pets");

test("a request with only a pre-request script asks for trust like a handler; Cancel sends nothing", async ({ page }) => {
  await openApp(page, "?preScript=sign");
  await openListPets(page);
  await send(page);
  const prompt = trustPrompt(page);
  await expect(prompt).toContainText("This request has a script.");
  for (const name of ["Cancel", "Send without scripts", "Trust and run"]) {
    await expect(prompt.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toBeHidden();
  expect(await sentRequests(page)).toEqual([]);
});

test("Trust and run sends with the script and trusts the workspace", async ({ page }) => {
  await openApp(page, "?preScript=sign");
  await openListPets(page);
  await send(page);
  await trustPrompt(page).getByRole("button", { name: "Trust and run" }).click();
  await expect.poll(() => mockState(page, "sentSkipScripts")).toEqual([false]);
  expect((await mockState(page, "settings")).trustedWorkspaces).toEqual(["/demo"]);
});

test("Send without scripts says the pre-request script didn't run", async ({ page }) => {
  await openApp(page, "?preScript=sign");
  await openListPets(page);
  await send(page);
  await trustPrompt(page).getByRole("button", { name: "Send without scripts" }).click();
  await expect(page.getByText("Sent without scripts: the pre-request script didn't run.")).toBeVisible();
});

test("a failing pre-request script shows its line and message instead of a response", async ({ page }) => {
  await openApp(page, "?preScript=fail&trusted=1");
  await openListPets(page);
  await send(page);
  const panel = page.locator(".send-error");
  await expect(panel).toContainText("Pre-request script failed");
  await expect(panel).toContainText("no token (line 3)");
  await expect(panel).toContainText("Nothing was sent. The error is at line 3 of the pre-request script.");
  await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
});
