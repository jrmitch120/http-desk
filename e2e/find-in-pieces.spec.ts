// Find works through a large body a piece at a time (#114): the find bar says
// "Searching…" meanwhile, and a new query or closing the bar abandons the
// search. The body is the perf test's fixture at about 4 MB (src/dev/mock.ts
// `preparePerf`), whose Pretty is about 7 MB and takes a Find a while.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";

/** A term only the body's last item has. */
const NEEDLE = "needle-near-the-end";
/** A term only the body's fourth item has. */
const NEAR_THE_START = '"pet-3"';

async function openFindInLargeBody(page: Page): Promise<void> {
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __mock: { preparePerf(jsonBytes: number): void } }).__mock.preparePerf(4_000_000));
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".body .cm-content")).toContainText('"items": [');
  await page.getByRole("button", { name: "Search" }).click();
}

const findBar = (page: Page) => page.getByRole("search", { name: "Find in editor" });
const selectedMatch = (page: Page) => page.locator(".cm-searchMatch-selected");

test("on a large body Find says it's searching, then selects a match near the end and scrolls to it", async ({ page }) => {
  await openFindInLargeBody(page);
  const bar = findBar(page);
  const field = bar.getByRole("textbox", { name: "Find" });

  await field.fill(NEEDLE);
  await field.press("Enter");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await expect(selectedMatch(page)).toHaveText(NEEDLE);
  await expect(selectedMatch(page)).toBeInViewport();
  await expect(bar.getByText("Searching…")).toHaveCount(0);
});

test("the find keys search in pieces too, and Find previous wraps round", async ({ page }) => {
  await openFindInLargeBody(page);
  const bar = findBar(page);
  await bar.getByRole("textbox", { name: "Find" }).fill(NEEDLE);

  await page.keyboard.press("F3");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await expect(selectedMatch(page)).toHaveText(NEEDLE);
  await expect(bar.getByText("Searching…")).toHaveCount(0);

  // The only match: back through the whole body, round from the end to itself.
  await page.keyboard.press("Shift+F3");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await expect(bar.getByText("Searching…")).toHaveCount(0);
  await expect(selectedMatch(page)).toHaveText(NEEDLE);
  await expect(selectedMatch(page)).toBeInViewport();
});

test("selecting the next occurrence (Mod-d) and every occurrence (Mod-Shift-l) search in pieces too", async ({ page }) => {
  await openFindInLargeBody(page);
  const bar = findBar(page);
  const field = bar.getByRole("textbox", { name: "Find" });
  await field.fill(NEEDLE);
  await field.press("Enter");
  await expect(selectedMatch(page)).toHaveText(NEEDLE);
  await page.locator(".body .cm-content").focus();
  const selected = () => page.locator(".body .cm-content").evaluate(() => getSelection()?.toString());

  // The only occurrence: on through the end and round from the start, finding no other.
  await page.keyboard.press("ControlOrMeta+d");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await expect(bar.getByText("Searching…")).toHaveCount(0);
  expect(await selected()).toBe(NEEDLE);

  // Every occurrence: the whole body, which has just the one.
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await expect(bar.getByText("Searching…")).toHaveCount(0);
  expect(await selected()).toBe(NEEDLE);
});

test("a new query, or closing the bar, abandons the search in progress", async ({ page }) => {
  await openFindInLargeBody(page);
  const bar = findBar(page);
  const field = bar.getByRole("textbox", { name: "Find" });

  // How long a search takes that goes through nearly the whole body.
  await field.fill(NEEDLE);
  const started = Date.now();
  await field.press("Enter");
  await expect(selectedMatch(page)).toHaveText(NEEDLE);
  const searchMs = Date.now() - started;
  /** Long enough for an abandoned search to have finished, had it carried on. */
  const outlast = () => page.waitForTimeout(2 * searchMs + 500);

  // Round from the needle to itself again; a new query part way stops that.
  await field.press("Enter");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await field.fill(NEAR_THE_START);
  await expect(bar.getByText("Searching…")).toHaveCount(0);
  await field.press("Enter");
  await expect(selectedMatch(page)).toHaveText(NEAR_THE_START);
  await outlast();
  await expect(selectedMatch(page)).toHaveText(NEAR_THE_START);

  // From near the start towards the needle; closing the bar stops that.
  await field.fill(NEEDLE);
  await field.press("Enter");
  await expect(bar.getByText("Searching…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await outlast();
  await expect(page.locator(".body .cm-content")).not.toContainText(NEEDLE);
  await expect(page.locator(".body .cm-content")).toContainText(NEAR_THE_START);
});
