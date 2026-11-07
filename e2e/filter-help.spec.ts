// Help writing filters (#63): key completion in the filter bar, from the core's
// shape summary of the body (`response_shape`, fetched once per response), and
// "Copy path" in the body editor's context menu.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, sentRequests } from "./helpers";

async function send(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const filterBox = (page: Page) => page.getByRole("combobox", { name: "Filter with JSONPath" });
const keyList = (page: Page) => page.getByRole("listbox", { name: "Key suggestions" });
const bodyLines = (page: Page) => page.locator(".body .cm-content .cm-line");
const shapeRequests = (page: Page) => mockState(page, "shapeRequests");
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** Records clipboard writes instead of touching the real clipboard. */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void w.__copied.push(text), readText: async () => w.__copied.at(-1) ?? "" },
    });
  });
}

test("typing a path suggests the keys of the items there, and accepting one completes it", async ({ page }) => {
  await openApp(page);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await filterBox(page).click();
  await filterBox(page).pressSequentially("$.items[*].");
  await expect(keyList(page).getByRole("option")).toHaveText(["id", "name", "tags", "active", "owner"]);
  await filterBox(page).press("ArrowDown");
  await filterBox(page).press("Enter");
  await expect(filterBox(page)).toHaveValue("$.items[*].name");
  await expect(keyList(page)).toHaveCount(0);
  await expect(bodyLines(page)).toHaveText(["[", '  "Rex",', '  "Tom"', "]"]);

  // Every keystroke completed from the one summary fetched for this response.
  expect(await shapeRequests(page)).toEqual(["r1-1"]);
});

test("the shape summary is fetched once per response", async ({ page }) => {
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await filterBox(page).click();
  await filterBox(page).pressSequentially("$.items[0].st");
  await expect(keyList(page).getByRole("option")).toHaveText(["status"]);
  await filterBox(page).press("Escape");
  await expect(keyList(page)).toHaveCount(0);
  await expect(filterBox(page)).toHaveValue("$.items[0].st");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await sentRequests(page)).length).toBe(2);
  await expect(page.locator(".statusbar .loading")).toHaveCount(0);
  await filterBox(page).press("End");
  await filterBox(page).press("Backspace");
  await expect(keyList(page).getByRole("option")).toHaveText(["status"]);
  expect(await shapeRequests(page)).toEqual(["r1-1", "r1-2"]);
});

test("Copy path gives the path of the value under the cursor in Pretty view", async ({ page }) => {
  await recordClipboard(page);
  await openApp(page, "?response=nested");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  const one = bodyLines(page).filter({ hasText: '"b": 1' }).getByText("1", { exact: true });
  await one.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  await expect.poll(() => copied(page)).toEqual(["$.a['odd key'][0].b"]);

  // From the keyboard: Shift+F10 opens the menu at the caret.
  await bodyLines(page).filter({ hasText: '"odd key"' }).getByText('"odd key"').click();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  await expect.poll(() => copied(page)).toEqual(["$.a['odd key'][0].b", "$.a['odd key']"]);
});

test("Copy path is disabled while a filter is on, and absent for non-JSON bodies", async ({ page }) => {
  await openApp(page, "?response=nested");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await filterBox(page).fill("$.a");
  await expect(page.locator(".filter-bar")).toContainText("1 match");
  await bodyLines(page).filter({ hasText: '"b": 1' }).getByText("1", { exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await openApp(page, "?response=html");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Raw" }).click();
  await bodyLines(page).first().click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Copy", "Select all"]);
});
