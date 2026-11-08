// The JSONPath filter bar for JSON responses (#62). The mocked
// `filter_response` evaluates a subset of RFC 9535 and keeps number tokens as
// the server wrote them, like the core.
import { expect, test, type Page } from "@playwright/test";
import { mockState, openApp, openRequest, sentRequests, tab } from "./helpers";

const SOLD_IDS = '$.items[?(@.status=="sold")].id';

async function send(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".statusbar .metric").first()).toBeVisible();
}

const filterBox = (page: Page) => page.getByRole("combobox", { name: "Filter with JSONPath" });
const bodyLines = (page: Page) => page.locator(".body .cm-content .cm-line");
const prettyRadio = (page: Page) => page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name: "Pretty" });

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

test("a filter narrows the response to its matches, exactly, and clearing it restores the body", async ({ page }) => {
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await filterBox(page).fill(SOLD_IDS);
  await expect(bodyLines(page)).toHaveText(["[", "  1234567890123456789,", "  9007199254740993", "]"]);
  await expect(page.locator(".filter-bar")).toContainText("2 matches");
  await expect(prettyRadio(page)).toBeDisabled();

  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(filterBox(page)).toHaveValue("");
  await expect(page.locator(".body .cm-content")).toContainText('"status": "available"');
  await expect(page.locator(".body .cm-content")).toContainText('"price": 10.50');
  await expect(prettyRadio(page)).toBeEnabled();
});

test("an invalid expression shows its error inline and keeps the full body", async ({ page }) => {
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);

  await filterBox(page).fill("$.items[?(@.status==");
  await expect(page.locator(".filter-bar [role=alert]")).toContainText("Invalid JSONPath");
  await expect(page.locator(".body .cm-content")).toContainText('"status": "available"');
  await expect(page.locator(".filter-bar")).not.toContainText("matches");
});

test("Copy copies the filtered text and Save writes the full body", async ({ page }) => {
  await recordClipboard(page);
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await filterBox(page).fill(SOLD_IDS);
  await expect(page.locator(".filter-bar")).toContainText("2 matches");

  await page.getByRole("button", { name: "Copy body" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([
    "[\n  1234567890123456789,\n  9007199254740993\n]",
  ]);

  await page.getByRole("button", { name: "Save body to file" }).click();
  const saved = () => mockState(page, "savedBodies");
  await expect.poll(async () => Object.values(await saved())).toHaveLength(1);
  const [body] = Object.values(await saved());
  expect(body).toContain('"status":"available"');
  expect(body).toContain('"id":1234567890123456789');
});

test("the filter survives switching tabs and is re-applied to the next response", async ({ page }) => {
  await openApp(page, "?response=store");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await filterBox(page).fill(SOLD_IDS);
  await expect(page.locator(".filter-bar")).toContainText("2 matches");

  await openRequest(page, ["api", "pets.http"], "Create pet");
  await tab(page, "List pets").click();
  await expect(filterBox(page)).toHaveValue(SOLD_IDS);
  await expect(bodyLines(page)).toHaveText(["[", "  1234567890123456789,", "  9007199254740993", "]"]);

  // The mock marks item 2 as sold from the second send on. ⌘Enter / Ctrl+Enter sends
  // even with the tab strip focused (#74).
  await expect(tab(page, "List pets")).toBeFocused();
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await sentRequests(page)).length).toBe(2);
  await expect(page.locator(".filter-bar")).toContainText("3 matches");
  await expect(bodyLines(page)).toHaveText(["[", "  1234567890123456789,", "  2,", "  9007199254740993", "]"]);
});

test("the filter bar is absent for an HTML response and for a truncated JSON body", async ({ page }) => {
  await openApp(page, "?response=html");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect(page.locator(".body")).toBeVisible();
  await expect(filterBox(page)).toHaveCount(0);

  await openApp(page, "?response=truncated");
  await openRequest(page, ["api", "pets.http"], "List pets");
  await send(page);
  await expect(page.getByText("Body truncated at the configured size limit")).toBeVisible();
  await expect(filterBox(page)).toHaveCount(0);
});
