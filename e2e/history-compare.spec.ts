// Compare (#158): how two responses differ, bodies and headers side by side in a merge
// view. An entry compares with the tab's current response, else with the next newer
// entry ("vs. [time]"); two entries selected in the list compare with each other. JSON
// bodies are formatted with their keys sorted first, so key order and spacing don't
// show. Entries opened for the compare are released when it closes (ADR-0006).
import { expect, test, type Page } from "@playwright/test";
import { dialog, mockState, openApp, openRequest, setMockResponse } from "./helpers";

const status = (page: Page) => page.locator(".statusbar").first();
const historyButton = (page: Page) => page.getByRole("button", { name: "History", exact: true });
const entries = (page: Page) => page.getByRole("list", { name: "History entries" }).getByRole("listitem");
const compare = (page: Page) => dialog(page, "Compare");
/** The lines the merge view marks as changed on side `a` (older) or `b` (newer). */
const changed = (page: Page, side: "a" | "b") => compare(page).locator(`.cm-merge-${side} .cm-changedLine`);

async function send(page: Page, kind: string | null = null) {
  await setMockResponse(page, kind);
  await page.keyboard.press("Meta+Enter");
  await expect(status(page).locator(".metric", { hasText: "Size" })).toBeVisible({ timeout: 5000 });
}

async function compareFromMenu(page: Page, index: number, item: RegExp) {
  await entries(page).nth(index).getByRole("button").click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

test("an entry compared with a changed current response shows the changed body lines and headers", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page, "petsChanged");
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(2);
  const releasedBefore = await mockState(page, "releasedResponses");

  await compareFromMenu(page, 1, /^Compare with the current response$/);

  await expect(compare(page)).toContainText("vs. current response");
  await expect(changed(page, "a")).toContainText(['"name": "Rex"']);
  await expect(changed(page, "b")).toContainText(['"name": "Max"']);
  await compare(page).getByRole("radio", { name: "Headers" }).click();
  await expect(changed(page, "b").filter({ hasText: "x-api-version: 2" })).toHaveCount(1);

  await compare(page).getByRole("button", { name: "Close" }).click();
  await expect(compare(page)).toHaveCount(0);
  // Only the entry opened for the compare goes; the tab keeps its own response.
  const released = (await mockState(page, "releasedResponses")).slice(releasedBefore.length);
  expect(released).toHaveLength(1);
  expect(released[0]).toMatch(/^h-/);
});

test("with no current response, Compare uses the next newer entry and says so", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page, "petsChanged");
  // A fresh tab on the same request has no current response.
  await page.keyboard.press("Meta+W");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(2);
  const newer = await entries(page).nth(0).locator(".metric").first().textContent();

  // The newest entry has nothing newer to compare with.
  await entries(page).nth(0).getByRole("button").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  await compareFromMenu(page, 1, /^Compare with the next newer entry/);

  await expect(compare(page)).toContainText(`vs. ${newer}`);
  await expect(changed(page, "a")).toContainText(['"name": "Rex"']);
  await expect(changed(page, "b")).toContainText(['"name": "Max"']);
  await compare(page).getByRole("button", { name: "Close" }).click();
  const released = await mockState(page, "releasedResponses");
  expect(released.filter((id) => id.startsWith("h-"))).toHaveLength(2);
});

test("two selected entries can be compared", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page, "petsChanged");
  await send(page);
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(3);
  const compareSelected = page.getByRole("button", { name: "Compare selected" });

  await entries(page).nth(1).getByRole("checkbox").click();
  await expect(compareSelected).toBeDisabled();
  await entries(page).nth(2).getByRole("checkbox").click();
  await compareSelected.click();

  // The older of the two on the left.
  const [newer, older] = await Promise.all([1, 2].map((i) => entries(page).nth(i).locator(".metric").first().textContent()));
  await expect(compare(page)).toContainText(`${older} vs. ${newer}`);
  await expect(changed(page, "a")).toContainText(['"name": "Rex"']);
  await expect(changed(page, "b")).toContainText(['"name": "Max"']);
});

test("a response from History isn't the current response: Compare uses the next newer entry, never the entry itself", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page, "petsChanged");
  // Reopened, the tab shows the newest entry's response, from History.
  await page.keyboard.press("Meta+W");
  await page.keyboard.press("Meta+Shift+T");
  await expect(page.locator(".statusbar").getByText(/^from History, /)).toBeVisible();
  await historyButton(page).click();
  await expect(entries(page)).toHaveCount(2);
  const newer = await entries(page).nth(0).locator(".metric").first().textContent();

  // The newest entry is the response shown: there's nothing to compare it with.
  await entries(page).nth(0).getByRole("button").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Compare/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  await compareFromMenu(page, 1, /^Compare with the next newer entry/);
  await expect(compare(page)).toContainText(`vs. ${newer}`);
  await expect(changed(page, "b")).toContainText(['"name": "Max"']);
});

test("bodies over 1 MB are too large to compare, and their headers still compare", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  // A 1.5 MB JSON body.
  await send(page, "bigJson");
  await historyButton(page).click();
  const fetched = (await mockState(page, "bodyRequests")).length;

  await compareFromMenu(page, 1, /^Compare with the current response$/);

  await expect(compare(page).getByText("The bodies are too large to compare (over 1 MB)")).toBeVisible();
  await expect(compare(page).locator(".cm-mergeView")).toHaveCount(0);
  // Neither body was fetched to be laid out.
  expect((await mockState(page, "bodyRequests")).slice(fetched).filter((r) => r.view === "compare")).toEqual([]);
  await compare(page).getByRole("radio", { name: "Headers" }).click();
  await expect(changed(page, "b").filter({ hasText: "content-length: " })).toHaveCount(1);
});

test("JSON with the same content in a different key order and spacing shows no difference", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await send(page, "petsReordered");
  await historyButton(page).click();

  await compareFromMenu(page, 1, /^Compare with the current response$/);

  await expect(compare(page).locator(".cm-merge-b")).toContainText('"name": "Rex"');
  await expect(compare(page).getByText("The bodies are the same")).toBeVisible();
  await expect(compare(page).locator(".cm-changedLine")).toHaveCount(0);
});
