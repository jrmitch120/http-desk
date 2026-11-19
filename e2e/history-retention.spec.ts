// History kept bounded (#155): a body over the 10 MB cap is kept cut off and marked
// "Truncated at 10 MB" (a binary one keeps only its headers and size); an entry can be
// deleted, and a workspace's History cleared, from either History view after
// confirming; retention's limits are edited in Settings. The mock's `?historyCap=`
// lowers the cap so a test needn't send 10 MB.
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, seedHistory } from "./helpers";

const status = (page: Page) => page.locator(".statusbar").first();
const historyButton = (page: Page) => page.getByRole("radiogroup", { name: "Response pane" }).getByRole("radio", { name: "History" });
const requestEntries = (page: Page) => page.locator(".viewer").getByRole("list", { name: "History entries" }).getByRole("listitem");
const sidebarHistory = (page: Page) => page.getByRole("region", { name: "Workspace History" });
const sidebarEntries = (page: Page) => sidebarHistory(page).getByRole("list", { name: "History entries" }).getByRole("listitem");

async function send(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

async function showSidebarHistory(page: Page) {
  await page.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "History" }).click();
  await expect(sidebarHistory(page)).toBeVisible();
}

test("an entry whose text body was over the cap shows it cut off, marked Truncated at 10 MB", async ({ page }) => {
  await openApp(page, "?historyCap=20");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  // The live response is whole.
  await expect(page.getByText("Truncated at 10 MB")).toHaveCount(0);
  await historyButton(page).click();

  await requestEntries(page).first().getByRole("button").click();

  const entry = page.getByRole("region", { name: "History entry" });
  await expect(entry.getByText("Truncated at 10 MB")).toBeVisible();
  await expect(entry.locator(".body .cm-content")).toContainText('"items"');
  await expect(entry.locator(".body .cm-content")).not.toContainText("Rex");
});

test("an entry whose binary body was over the cap keeps only its headers and size", async ({ page }) => {
  await openApp(page, "?historyCap=40");
  await openRequest(page, ["api", "pets.http"], "Get pet image");
  await send(page);
  await historyButton(page).click();

  await requestEntries(page).first().getByRole("button").click();

  const entry = page.getByRole("region", { name: "History entry" });
  await expect(entry.getByText("History keeps only the headers and size of a binary body over 10 MB")).toBeVisible();
  await expect(entry.getByRole("img", { name: "Response preview" })).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "Save body to file" })).toHaveCount(0);
  await entry.getByRole("radio", { name: /Headers/ }).click();
  await expect(entry.getByText("image/png")).toBeVisible();
});

test("deleting an entry from the request's History asks first, then removes it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page);
  await historyButton(page).click();
  await expect(requestEntries(page)).toHaveCount(2);

  await requestEntries(page).first().getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const confirm = dialog(page, "Delete this History entry?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(requestEntries(page)).toHaveCount(2);

  await requestEntries(page).first().getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();

  await expect(requestEntries(page)).toHaveCount(1);
  expect(await mockState(page, "history")).toHaveLength(1);
});

test("Delete on a row of the sidebar's History deletes it after confirming", async ({ page }) => {
  await seedHistory(page, [
    { url: "https://api.test/one", time: "2026-11-16T09:00:00Z" },
    { url: "https://api.test/two", time: "2026-11-16T09:01:00Z" },
  ]);
  await openApp(page);
  await showSidebarHistory(page);

  await sidebarEntries(page).first().getByRole("button").focus();
  await page.keyboard.press("Delete");
  await dialog(page, "Delete this History entry?").getByRole("button", { name: "Delete" }).click();

  await expect(sidebarEntries(page)).toHaveCount(1);
  await expect(sidebarEntries(page).first()).toContainText("https://api.test/one");
});

test("an entry open in a tab's History closes when it's deleted from the sidebar, releasing its response", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await historyButton(page).click();
  await requestEntries(page).first().getByRole("button").click();
  await expect(page.getByRole("region", { name: "History entry" })).toBeVisible();
  await showSidebarHistory(page);

  await sidebarEntries(page).first().getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog(page, "Delete this History entry?").getByRole("button", { name: "Delete" }).click();

  await expect(page.getByRole("region", { name: "History entry" })).toHaveCount(0);
  await expect(page.getByText("No History for this request yet")).toBeVisible();
  const released = await mockState(page, "releasedResponses");
  expect(released.filter((id) => id.startsWith("h-"))).toHaveLength(1);
});

test("Clear workspace history in the sidebar empties the list after confirming, leaving other workspaces' History", async ({ page }) => {
  await seedHistory(page, [
    { url: "https://api.test/one", time: "2026-11-16T09:00:00Z" },
    { url: "https://api.test/two", time: "2026-11-16T09:01:00Z" },
  ]);
  await page.addInitScript(() => {
    const stored = JSON.parse(sessionStorage.getItem("httpdesk-mock-history") ?? "[]");
    if (stored.some((e: { workspace: string }) => e.workspace === "/elsewhere")) return;
    stored.push({ ...stored[0], id: 99, workspace: "/elsewhere" });
    sessionStorage.setItem("httpdesk-mock-history", JSON.stringify(stored));
  });
  await openApp(page);
  await showSidebarHistory(page);
  await expect(sidebarEntries(page)).toHaveCount(2);

  await sidebarHistory(page).getByRole("button", { name: "Clear workspace history" }).click();
  const confirm = dialog(page, "Clear workspace history?");
  await confirm.getByRole("button", { name: "Clear workspace history" }).click();

  await expect(sidebarHistory(page).getByText("No History in this workspace yet")).toBeVisible();
  await expect(sidebarHistory(page).getByRole("button", { name: "Clear workspace history" })).toBeDisabled();
  const left = await mockState(page, "history");
  expect(left.map((e) => e.workspace)).toEqual(["/elsewhere"]);
});

test("Clear workspace history is only in the sidebar's History view, not a request's", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await historyButton(page).click();
  await expect(requestEntries(page)).toHaveCount(1);

  await expect(page.locator(".viewer").getByRole("button", { name: "Clear workspace history" })).toHaveCount(0);
  await showSidebarHistory(page);
  await expect(sidebarHistory(page).getByRole("button", { name: "Clear workspace history" })).toBeEnabled();
});

test("retention limits are edited in Settings, and kept after a reload", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+Comma");
  const settings = dialog(page, "Settings");
  const perRequest = settings.getByRole("textbox", { name: "Entries per request" });
  const days = settings.getByRole("textbox", { name: "Keep for" });
  const size = settings.getByRole("textbox", { name: "Total size" });
  await expect(perRequest).toHaveValue("50");
  await expect(days).toHaveValue("30");
  await expect(size).toHaveValue("200");

  await perRequest.fill("0");
  await expect(settings.getByRole("alert")).toHaveText("Must be at least 1");
  await perRequest.fill("10");
  await perRequest.press("Enter");
  await days.fill("7");
  await days.press("Enter");
  await size.fill("50");
  await size.press("Enter");
  await expect
    .poll(async () => (await mockState(page, "settings")).history)
    .toEqual({ enabled: true, maxPerRequest: 10, maxAgeDays: 7, maxSizeMb: 50 });

  await page.reload();
  await expect(page.getByRole("treeitem").first()).toBeVisible();
  await page.keyboard.press("Meta+Comma");
  await expect(dialog(page, "Settings").getByRole("textbox", { name: "Entries per request" })).toHaveValue("10");
  await expect(dialog(page, "Settings").getByRole("textbox", { name: "Keep for" })).toHaveValue("7");
  await expect(dialog(page, "Settings").getByRole("textbox", { name: "Total size" })).toHaveValue("50");
});
