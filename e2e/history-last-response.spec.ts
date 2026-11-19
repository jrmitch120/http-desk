// #159: a tab restored with the Layout, or reopened with ⌘⇧T, shows its request's
// latest History entry as its response, marked "from History, [time]", loaded the
// first time the tab is shown. It isn't put into the Session, so Request variables
// reading it still count the request unsent. With History off, or for a request marked
// `# @no-log`, the tab has no response. The mock keeps Layouts and History in
// sessionStorage, so a page reload stands in for a restart; `historyOpened` lists
// the entries `open_history_entry` opened.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, dialog, mockState, openApp, openRequest, tab, treeItem } from "./helpers";

const marker = (page: Page) => page.locator(".statusbar").getByText(/^from History, /);
const status = (page: Page) => page.locator(".statusbar .badge").first();
const noResponse = (page: Page) => page.getByText("to get a response");
const blocked = (page: Page) => page.getByRole("alert").filter({ hasText: "Request not sent in this Session" });

/** Sends the active tab's request and waits for History to record it. */
async function send(page: Page) {
  const before = (await mockState(page, "history")).length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await mockState(page, "history")).length).toBe(before + 1);
  await expect(status(page)).toBeVisible();
}

/** Waits for the Layout to be saved with `names` as its tabs, then reloads (a restart). */
async function restart(page: Page, names: string[]) {
  await expect
    .poll(async () => ((await mockState(page, "layouts"))["/demo"] as { tabs: { name: string }[] } | undefined)?.tabs.map((t) => t.name))
    .toEqual(names);
  await page.reload();
  await expect(treeItem(page, "api")).toBeVisible();
}

const historyOpened = (page: Page) => mockState(page, "historyOpened");

async function turnHistoryOff(page: Page) {
  await page.keyboard.press("Meta+Comma");
  await dialog(page, "Settings").getByRole("region", { name: "History" }).getByRole("switch", { name: "Record History" }).click();
  await dialog(page, "Also delete existing history?").getByRole("button", { name: "Keep" }).click();
  await expect.poll(async () => (await mockState(page, "settings")).history.enabled).toBe(false);
  await page.keyboard.press("Escape");
}

test("after a restart, a restored tab shows its last response marked from History, loaded only once the tab is shown", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);

  await restart(page, ["List pets", "Create pet"]);

  await expect(activeTab(page)).toContainText("Create pet");
  await expect(status(page)).toHaveText("201 Created");
  await expect(marker(page)).toBeVisible();
  // List pets' tab hasn't been shown yet, so its entry isn't opened.
  expect(await historyOpened(page)).toHaveLength(1);

  await tab(page, "List pets").click();
  await expect(status(page)).toHaveText("200 OK");
  await expect(marker(page)).toBeVisible();
  expect(await historyOpened(page)).toHaveLength(2);
  // Showing it again doesn't open it again.
  await tab(page, "Create pet").click();
  await tab(page, "List pets").click();
  await expect(marker(page)).toBeVisible();
  expect(await historyOpened(page)).toHaveLength(2);
});

test("a reopened tab shows its last response from History; a tab opened from the tree doesn't", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await page.keyboard.press("Meta+W");
  await expect(tab(page, "List pets")).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+T");

  await expect(activeTab(page)).toContainText("List pets");
  await expect(status(page)).toHaveText("200 OK");
  await expect(marker(page)).toBeVisible();

  // Closing releases it (ADR-0006); opening the request from the tree shows no response.
  const opened = (await historyOpened(page)).length;
  await page.keyboard.press("Meta+W");
  await expect.poll(async () => (await mockState(page, "releasedResponses")).some((id) => id.startsWith("h-"))).toBe(true);
  await treeItem(page, "List pets").click();
  await expect(noResponse(page)).toBeVisible();
  expect(await historyOpened(page)).toHaveLength(opened);
});

test("a request reading a restored response still asks for it to be sent, and the Session lists none", async ({ page }) => {
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);

  await restart(page, ["Get pet image", "Create pet"]);

  await expect(activeTab(page)).toContainText("Create pet");
  await expect(marker(page)).toBeVisible();
  await tab(page, "Get pet image").click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(blocked(page)).toContainText("This request reads the response of `createPet`, so send `createPet` first.");
  expect(await mockState(page, "sent")).toEqual([]);
  await page.keyboard.press("Meta+j");
  await expect(page.getByRole("region", { name: "Session" })).toContainText("No named exchanges");
});

test("with History off, restored and reopened tabs have no response", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await turnHistoryOff(page);

  await restart(page, ["List pets", "Create pet"]);

  await expect(activeTab(page)).toContainText("Create pet");
  await expect(noResponse(page)).toBeVisible();
  await page.keyboard.press("Meta+W");
  await page.keyboard.press("Meta+Shift+T");
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(noResponse(page)).toBeVisible();
  await tab(page, "List pets").click();
  await expect(noResponse(page)).toBeVisible();
  expect(await historyOpened(page)).toEqual([]);
});

test("a request marked # @no-log comes back without a response, even with entries from before", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect.poll(async () => (await mockState(page, "layouts"))["/demo"]).toBeTruthy();
  await page.evaluate((path) => {
    const mock = (window as unknown as { __mock: { files: Record<string, { requests: { directives: unknown[] }[] }>; writeFile: (p: string, f: unknown) => void } }).__mock;
    const file = mock.files[path];
    file.requests[0].directives.push({ name: "no-log", value: "" });
    mock.writeFile(path, file);
  }, "/demo/api/pets.http");

  await restart(page, ["List pets"]);

  await expect(activeTab(page)).toContainText("List pets");
  await expect(noResponse(page)).toBeVisible();
  expect(await historyOpened(page)).toEqual([]);
});

test("sending replaces the restored response and removes the marker", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await restart(page, ["List pets"]);
  await expect(marker(page)).toBeVisible();
  const restored = (await historyOpened(page)).length;
  expect(restored).toBe(1);

  await send(page);

  await expect(status(page)).toHaveText("200 OK");
  await expect(marker(page)).toHaveCount(0);
  // The restored response's body is released once the live one replaces it (ADR-0006).
  await expect.poll(async () => (await mockState(page, "releasedResponses")).some((id) => id.startsWith("h-"))).toBe(true);
});
