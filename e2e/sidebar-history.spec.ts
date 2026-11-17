// The whole workspace's History in the sidebar (#156): a History view next to the
// Explorer lists every entry, newest first, whatever request it came from, with the
// request's file. It filters by status class and text, pages through long lists, and
// opens an entry read-only in the response viewer.
import { expect, test, type Page } from "@playwright/test";
import { activeTab, dialog, mockState, openApp, openRequest, searchBox, seedHistory, setMockResponse, tab, treeItem, treeMenu, urlBar } from "./helpers";

const status = (page: Page) => page.locator(".statusbar").first();
const sidebarView = (page: Page) => page.getByRole("radiogroup", { name: "Sidebar" });
const history = (page: Page) => page.getByRole("region", { name: "Workspace History" });
const entries = (page: Page) => history(page).getByRole("list", { name: "History entries" }).getByRole("listitem");

async function send(page: Page) {
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

async function showHistory(page: Page) {
  await sidebarView(page).getByRole("radio", { name: "History" }).click();
  await expect(history(page)).toBeVisible();
}

test("sends from two files both appear in the sidebar's History, newest first, with their files", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Multi-line query");
  await send(page);

  await showHistory(page);

  await expect(entries(page)).toHaveCount(2);
  // The mock answers every send from the same URL, so files tell them apart.
  await expect(entries(page).nth(0)).toContainText("samples/jetbrains.http");
  await expect(entries(page).nth(0)).toContainText("GET");
  await expect(entries(page).nth(0)).toContainText("http://127.0.0.1:8765/pets?limit=20");
  await expect(entries(page).nth(0)).toContainText("200");
  await expect(entries(page).nth(1)).toContainText("api/pets.http");
  // The Explorer's tree and search are hidden while History shows.
  await expect(page.getByRole("tree", { name: "Explorer" })).toBeHidden();

  await sidebarView(page).getByRole("radio", { name: "Explorer" }).click();
  await expect(page.getByRole("tree", { name: "Explorer" })).toBeVisible();
});

test("Search Requests from the History view goes back to the Explorer, its search box focused", async ({ page }) => {
  await openApp(page);
  await showHistory(page);

  await page.keyboard.press("Meta+p");

  await expect(searchBox(page)).toBeFocused();
  await expect(sidebarView(page).getByRole("radio", { name: "Explorer" })).toHaveAttribute("aria-checked", "true");
});

test("an entry opens read-only in the response viewer, and closing it releases its response", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await showHistory(page);

  await entries(page).first().getByRole("button").click();

  const opened = dialog(page, "History entry");
  await expect(opened).toContainText("from api/pets.http");
  await expect(opened).toContainText("read-only");
  const viewer = opened.getByRole("region", { name: "History entry" });
  await expect(viewer.locator(".body .cm-content")).toContainText('"name": "Rex"');
  await viewer.getByRole("radio", { name: "Request" }).click();
  // The request as sent, its credentials masked.
  await expect(viewer.getByText("••••••••")).toBeVisible();
  // Nothing to send again or browse from here: it's an entry, not a request.
  await expect(viewer.getByRole("button", { name: "History", exact: true })).toHaveCount(0);
  await expect(entries(page).first().getByRole("button")).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("Escape");
  await expect(opened).toBeHidden();
  const released = await mockState(page, "releasedResponses");
  expect(released.filter((id) => id.startsWith("h-"))).toHaveLength(1);
});

/** The URLs the sidebar's History lists, in order. */
const urls = (page: Page) => entries(page).locator(".url");
/** Picks status class `name` from the sidebar's Status class dropdown. */
async function statusClass(page: Page, name: string) {
  await history(page).getByRole("combobox", { name: "Status class" }).click();
  await page.getByRole("listbox", { name: "Status class" }).getByRole("option", { name, exact: true }).click();
}
const filterText = (page: Page) => history(page).getByRole("textbox", { name: "Filter History" });

test("filtering by status class and by text narrows the list", async ({ page }) => {
  await seedHistory(page, [
    { url: "https://api.test/pets", status: 200, time: "2026-11-16T09:00:00Z" },
    { url: "https://api.test/pets/old", status: 301, time: "2026-11-16T09:01:00Z" },
    { url: "https://api.test/pets/9", status: 404, time: "2026-11-16T09:02:00Z" },
    { method: "POST", url: "https://api.test/owners", file: "api/owners.http", status: 503, time: "2026-11-16T09:03:00Z" },
    { url: "https://down.test/pets", status: null, error: "Connection refused", time: "2026-11-16T09:04:00Z" },
  ]);
  await openApp(page);
  await showHistory(page);
  await expect(urls(page)).toHaveText([
    "https://down.test/pets",
    "https://api.test/owners",
    "https://api.test/pets/9",
    "https://api.test/pets/old",
    "https://api.test/pets",
  ]);

  await statusClass(page, "4xx");
  await expect(urls(page)).toHaveText(["https://api.test/pets/9"]);
  await statusClass(page, "5xx");
  await expect(urls(page)).toHaveText(["https://api.test/owners"]);
  await statusClass(page, "Errors");
  await expect(urls(page)).toHaveText(["https://down.test/pets"]);
  await expect(entries(page).first()).toContainText("Error");
  await statusClass(page, "3xx");
  await expect(urls(page)).toHaveText(["https://api.test/pets/old"]);

  await statusClass(page, "All statuses");
  await filterText(page).fill("owners.HTTP");
  await expect(urls(page)).toHaveText(["https://api.test/owners"]);
  await filterText(page).fill("pets");
  await expect(urls(page)).toHaveCount(4);
  await statusClass(page, "2xx");
  await expect(urls(page)).toHaveText(["https://api.test/pets"]);
  await filterText(page).fill("nothing like this");
  await expect(history(page).getByText("No History entries match")).toBeVisible();
});

test("entries whose request was renamed or whose file was deleted still appear", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Multi-line query");
  await send(page);

  await treeMenu(page, "Multi-line query", "Rename…");
  await dialog(page, "Rename request").getByRole("textbox").fill("Comments");
  await page.keyboard.press("Enter");
  await expect(treeItem(page, "Comments")).toBeVisible();
  await treeMenu(page, "pets.http", "Move to Trash");
  await dialog(page, "Move to Trash").getByRole("button", { name: "Move to Trash" }).click();
  await expect(treeItem(page, "pets.http")).toHaveCount(0);

  await showHistory(page);
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).nth(0)).toContainText("samples/jetbrains.http");
  await expect(entries(page).nth(1)).toContainText("api/pets.http");
  await entries(page).nth(1).getByRole("button").click();
  await expect(dialog(page, "History entry").locator(".body .cm-content")).toContainText('"name": "Rex"');
});

test("a long History lists a page at a time, the next as the list scrolls to its end", async ({ page }) => {
  // 120 entries, a minute apart: /pets/120 is the newest.
  const at = (i: number) => new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString();
  await seedHistory(page, Array.from({ length: 120 }, (_, i) => ({ url: `https://api.test/pets/${i + 1}`, time: at(i + 1) })));
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await showHistory(page);

  await expect(entries(page)).toHaveCount(50);
  await expect(urls(page).first()).toHaveText("https://api.test/pets/120");
  await expect(urls(page).last()).toHaveText("https://api.test/pets/71");

  const showMore = history(page).getByRole("button", { name: "Show more" });
  await showMore.scrollIntoViewIfNeeded();
  await expect(entries(page)).toHaveCount(100);
  await expect(urls(page).nth(50)).toHaveText("https://api.test/pets/70");

  // A send lists again, keeping as many as were shown, the new entry first.
  await send(page);
  await expect(entries(page)).toHaveCount(100);
  await expect(urls(page).first()).toHaveText("http://127.0.0.1:8765/pets?limit=20");
  await expect(urls(page).last()).toHaveText("https://api.test/pets/22");

  await showMore.scrollIntoViewIfNeeded();
  await expect(entries(page)).toHaveCount(121);
  await expect(urls(page).last()).toHaveText("https://api.test/pets/1");
  await expect(showMore).toHaveCount(0);
});

test("at the sidebar's default width, the Explorer's buttons sit beside the view switch and the status class filter fits one row", async ({ page }) => {
  await openApp(page);
  expect((await page.locator("aside").boundingBox())?.width).toBe(280);
  const views = (await sidebarView(page).boundingBox())!;
  for (const name of ["New .http file", "New folder", "Import OpenAPI", "Refresh", "Collapse all"]) {
    const button = (await page.locator("aside").getByRole("button", { name, exact: true }).boundingBox())!;
    expect(button.y, `${name} on the switch's row`).toBeLessThan(views.y + views.height);
    expect(button.x, `${name} after the switch`).toBeGreaterThanOrEqual(views.x + views.width);
  }

  // Six status classes don't fit the sidebar side by side: they're a dropdown there, on one row with the filter.
  await showHistory(page);
  const status = (await history(page).getByRole("combobox", { name: "Status class" }).boundingBox())!;
  const filter = (await history(page).getByRole("textbox", { name: "Filter History" }).boundingBox())!;
  const clear = (await history(page).getByRole("button", { name: "Clear workspace history" }).boundingBox())!;
  for (const box of [filter, clear]) expect(Math.abs(box.y + box.height / 2 - (status.y + status.height / 2))).toBeLessThan(2);
  expect(clear.x + clear.width).toBeLessThanOrEqual(280);
});

test("Restore request from an entry opened in the sidebar brings its request back into its tab as unsaved edits", async ({ page }) => {
  // Create pet is `# @name createPet`: its entry finds it in its file after a URL edit.
  await openApp(page, "?chain=1");
  await openRequest(page, ["api", "pets.http"], "Create pet");
  await send(page);
  await urlBar(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("/v2");
  await page.keyboard.press("Meta+S");
  await expect(activeTab(page).locator(".dot")).toHaveCount(0);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await showHistory(page);

  await entries(page).first().getByRole("button").click();
  await dialog(page, "History entry").getByRole("button", { name: "Restore request" }).click();

  await expect(dialog(page, "History entry")).toHaveCount(0);
  await expect(activeTab(page)).toContainText("Create pet");
  await expect(tab(page, "Create pet")).toHaveCount(1);
  await expect(activeTab(page).locator(".dot")).toBeVisible();
  await expect(urlBar(page)).toHaveText("{{baseUrl}}/pets");
});

test("the sidebar's History compares an entry with the next newer one of its request, and two selected entries", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await setMockResponse(page, "petsChanged");
  await send(page);
  await openRequest(page, ["samples", "jetbrains.http"], "Multi-line query");
  await setMockResponse(page, null);
  await send(page);
  await showHistory(page);
  await expect(entries(page)).toHaveCount(3);
  const compare = dialog(page, "Compare");
  const listPetsNewer = await entries(page).nth(1).locator(".metric").first().textContent();

  // The oldest entry's next newer one of the same request, not the newest in the list.
  await entries(page).nth(2).getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Compare with the next newer entry/ }).click();
  await expect(compare).toContainText(`vs. ${listPetsNewer}`);
  await expect(compare.locator(".cm-merge-b .cm-changedLine")).toContainText(['"name": "Max"']);
  await compare.getByRole("button", { name: "Close" }).click();

  await entries(page).nth(0).getByRole("checkbox").click();
  await entries(page).nth(1).getByRole("checkbox").click();
  await history(page).getByRole("button", { name: "Compare selected" }).click();
  await expect(compare.locator(".cm-merge-a .cm-changedLine")).toContainText(['"name": "Max"']);
});
