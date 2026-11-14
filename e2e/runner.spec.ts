// #143: Run file sends every request of a file in order (GLOSSARY "Run") and the
// Runner panel follows it: each request's state, status, time and tests, Stop, and
// any result opened in the response viewer, without touching what the tabs show.
// The mock's pets.http is List pets (GET), Create pet (POST) and Get pet image (GET);
// samples/jetbrains.http's "Post with JSON body" tests for a 200 (the mock answers a
// POST with 201). `?trusted=1` trusts the workspace, `?download=slow` makes each
// send take 2 s, and `?prompts=` declares Prompt variables on List pets.
// #145: the Runner's options (a delay, stop on first failure) and Re-run failed.
import { expect, test, type Page } from "@playwright/test";
import { dialog, menuClick, mockState, openApp, openRequest, sentRequests, treeItem, treeMenu, urlBar } from "./helpers";

const runner = (page: Page) => page.getByRole("region", { name: "Runner" });
const row = (page: Page, name: string) => runner(page).getByRole("listitem").filter({ hasText: name });
const state = (page: Page, name: string, label: string) => row(page, name).getByRole("img", { name: label, exact: true });

/** Expands the folders of `path` (from the workspace root), then picks Run file on its file. */
async function runFile(page: Page, ...path: string[]) {
  for (const folder of path.slice(0, -1)) {
    const row = treeItem(page, folder);
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  }
  await treeMenu(page, path.at(-1)!, "Run file");
}

test("Run file sends every request in order and the panel shows each result, which opens in the response viewer", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");

  await runFile(page, "api", "pets.http");

  await expect(state(page, "Get pet image", "Passed")).toBeVisible();
  expect((await sentRequests(page)).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  await expect(runner(page)).toContainText("3 passed · 0 failed");
  await expect(row(page, "Create pet")).toContainText("201");

  await row(page, "Create pet").getByRole("button").click();
  const viewer = runner(page).locator(".result");
  await expect(viewer.locator(".statusbar")).toContainText("201 Created");
  await expect(viewer.locator(".cm-content")).toContainText('"method": "POST"');

  // The open tab still shows what it showed: it was never sent from the tab.
  await expect(page.locator(".response")).toContainText("to get a response");
});

test("a failing client.test fails its request, and an error status alone doesn't", async ({ page }) => {
  await openApp(page, "?trusted=1&status=404");

  await runFile(page, "samples", "jetbrains.http");

  await expect(state(page, "Send a form with the text and file fields", "Passed")).toBeVisible();
  await expect(state(page, "Post with JSON body", "Failed")).toBeVisible();
  await expect(row(page, "Post with JSON body")).toContainText("0 passed · 1 failed");
  await expect(state(page, "Get request with a header", "Passed")).toBeVisible();
  await expect(row(page, "Get request with a header")).toContainText("404");
  await expect(runner(page)).toContainText("4 passed · 1 failed");
});

test("an open tab's unsaved edits are sent and marked; other requests come from the file", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await urlBar(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("https://example.com/edited");

  await runFile(page, "api", "pets.http");

  await expect(state(page, "Get pet image", "Passed")).toBeVisible();
  expect((await sentRequests(page)).map((r) => r.url)).toEqual(["https://example.com/edited", "{{baseUrl}}/pets", "{{baseUrl}}/png/{{petId}}"]);
  await expect(row(page, "List pets")).toContainText("unsaved");
  await expect(row(page, "Create pet")).not.toContainText("unsaved");
});

test("with a Production environment, one confirmation lists the unsafe requests, and Cancel sends nothing", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Manage environments" }).click();
  const environments = dialog(page, "Environments");
  await environments.getByRole("checkbox", { name: "Production" }).click();
  await environments.getByRole("button", { name: "Save", exact: true }).click();
  await expect(environments).toBeHidden();

  await runFile(page, "api", "pets.http");
  const confirm = dialog(page, "Run against production?");
  await expect(confirm).toContainText('"local" is a production environment. This run sends:\n• POST Create pet');
  await expect(confirm).not.toContainText("List pets");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await expect(confirm).toBeHidden();
  expect(await sentRequests(page)).toEqual([]);
  await expect(runner(page)).toHaveCount(0);
});

test("unanswered prompts are asked once before the first send, and not again", async ({ page }) => {
  await openApp(page, `?prompts=${encodeURIComponent("otp One-time code;pass")}`);

  await runFile(page, "api", "pets.http");
  const form = dialog(page, "Values for this run");
  await expect(form).toContainText("One-time code");
  expect(await sentRequests(page)).toEqual([]);
  await form.getByLabel("otp", { exact: true }).fill("123456");
  await form.getByLabel("pass", { exact: true }).fill("s3cret");
  await form.getByRole("button", { name: "Run" }).click();
  await expect(state(page, "Get pet image", "Passed")).toBeVisible();
  expect((await mockState(page, "sentPrompts"))[0]).toEqual({ otp: "123456", pass: "s3cret" });

  await runFile(page, "api", "pets.http");
  await expect(state(page, "Get pet image", "Passed")).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(await sentRequests(page)).toHaveLength(6);
});

test("Stop cancels the request in flight, and the panel shows which requests didn't run", async ({ page }) => {
  await openApp(page, "?download=slow");

  await runFile(page, "api", "pets.http");
  await expect(state(page, "List pets", "Sending…")).toBeVisible();
  await runner(page).getByRole("button", { name: "Stop", exact: true }).click();

  await expect(state(page, "List pets", "Stopped")).toBeVisible();
  await expect(state(page, "Create pet", "Didn't run")).toBeVisible();
  await expect(state(page, "Get pet image", "Didn't run")).toBeVisible();
  await expect(runner(page)).toContainText("3 didn't run");
  await expect(runner(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(await sentRequests(page)).toHaveLength(1);
});

test("with Stop on first failure, a run ends at the first failing request and the rest don't run; the options are remembered", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await menuClick(page, "toggle-runner");
  const delay = runner(page).getByRole("textbox", { name: "Delay between requests" });
  await delay.fill("150");
  await delay.press("Enter");
  await runner(page).getByRole("switch", { name: "Stop on first failure" }).click();
  await expect.poll(async () => (await mockState(page, "settings")).runnerOptions).toEqual({ "/demo": { delayMs: 150, stopOnFailure: true } });

  await runFile(page, "samples", "jetbrains.http");

  await expect(state(page, "Post with JSON body", "Failed")).toBeVisible();
  for (const name of ["Multi-line query", "Basic auth", "Send a form with the text and file fields"]) {
    await expect(state(page, name, "Didn't run")).toBeVisible();
  }
  await expect(runner(page)).toContainText("1 passed · 1 failed · 3 didn't run");
  expect(await sentRequests(page)).toHaveLength(2);
  expect(await mockState(page, "runOptions")).toEqual([{ skipScripts: false, delayMs: 150, stopOnFailure: true }]);

  await page.reload();
  await expect(treeItem(page, "api")).toBeVisible();
  await menuClick(page, "toggle-runner");
  await expect(runner(page).getByRole("textbox", { name: "Delay between requests" })).toHaveValue("150");
  await expect(runner(page).getByRole("switch", { name: "Stop on first failure" })).toHaveAttribute("aria-checked", "true");
});

test("after fixing a failing request, Re-run failed runs only the failed ones, as the tab now shows them, and they pass", async ({ page }) => {
  await openApp(page, "?trusted=1");
  await runFile(page, "samples", "jetbrains.http");
  await expect(runner(page)).toContainText("4 passed · 1 failed");
  const rerun = runner(page).getByRole("button", { name: "Re-run failed" });

  // The fix: its test expects the 201 the mock answers a POST with. Left unsaved.
  await openRequest(page, ["samples", "jetbrains.http"], "Post with JSON body");
  await page.locator(".subtab", { hasText: "Settings" }).click();
  const handler = page.getByRole("group", { name: "Scripts" }).getByRole("group", { name: "Response handler" }).locator(".cm-content");
  await handler.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText('client.test("Created", function() { client.assert(response.status === 201, "Not 201"); });');
  await expect(handler).toContainText("response.status === 201");
  await rerun.click();

  await expect(state(page, "Post with JSON body", "Passed")).toBeVisible();
  await expect(runner(page).getByRole("listitem")).toHaveCount(1);
  await expect(row(page, "Post with JSON body")).toContainText("unsaved");
  await expect(runner(page)).toContainText("1 passed · 0 failed");
  const sent = await sentRequests(page);
  expect(sent).toHaveLength(6);
  expect(sent[5].method).toBe("POST");
  await expect(rerun).toHaveCount(0);
});

test("in a workspace that isn't trusted, a run with scripts asks once up front", async ({ page }) => {
  await openApp(page);

  await runFile(page, "samples", "jetbrains.http");
  const ask = dialog(page, "Run this workspace's scripts?");
  await expect(ask).toContainText("Requests in this run have scripts");
  expect(await sentRequests(page)).toEqual([]);
  await ask.getByRole("button", { name: "Run without scripts" }).click();

  await expect(state(page, "Send a form with the text and file fields", "Passed")).toBeVisible();
  expect(await mockState(page, "sentSkipScripts")).toEqual([true, true, true, true, true]);
});
