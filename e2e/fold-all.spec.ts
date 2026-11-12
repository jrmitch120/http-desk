// Fold all never freezes the window (#115): it parses the body in pieces,
// showing "Folding…", then folds; above a measured size it's turned off and
// points to the filter instead, while Unfold all and the gutter still work.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest, tabTo } from "./helpers";
import { FOLD_ALL_LIMIT } from "../src/lib/codemirror/foldAll";

/** Pretty text is about this many times the minified body (src/dev/perfFixtures.ts `largeJson`). */
const PRETTY_PER_JSON_BYTE = 1.76;

/** Opens List pets with the mock answering with a JSON body whose Pretty text is about `prettyBytes` long, and shows it. */
async function showBody(page: Page, prettyBytes: number): Promise<void> {
  await openApp(page);
  const jsonBytes = Math.round(prettyBytes / PRETTY_PER_JSON_BYTE);
  await page.evaluate((n) => (window as unknown as { __mock: { preparePerf(jsonBytes: number): void } }).__mock.preparePerf(n), jsonBytes);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(editor(page)).toContainText('"items": [', { timeout: 60_000 });
}

const editor = (page: Page) => page.locator(".body .cm-content");
const placeholders = (page: Page) => page.locator(".body .cm-foldPlaceholder");
const foldAll = (page: Page) => page.getByRole("button", { name: "Fold all", exact: true });

test("on a body under the limit, Fold all shows Folding… and then folds everything", async ({ page }) => {
  // Large enough to take a few hundred ms to parse, so "Folding…" shows.
  await showBody(page, 3_000_000);

  await foldAll(page).click();
  await expect(page.getByRole("status").filter({ hasText: "Folding…" })).toBeVisible();

  await expect(placeholders(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText("Folding…")).toHaveCount(0);
  // The whole body is one folded block: `{…}`.
  await expect(editor(page).locator(".cm-line")).toHaveCount(1);
  await expect(editor(page)).not.toContainText('"items"');

  await page.getByRole("button", { name: "Unfold all" }).click();
  await expect(placeholders(page)).toHaveCount(0);
  await expect(editor(page)).toContainText('"items": [');
});

test("Ctrl-Alt-[ folds all in pieces too", async ({ page }) => {
  await showBody(page, 200_000);
  await editor(page).click();
  await page.keyboard.press("Control+Alt+BracketLeft");
  await expect(placeholders(page)).toHaveCount(1);
  await expect(editor(page).locator(".cm-line")).toHaveCount(1);
});

test("on a body over the limit, Fold all is turned off and points to the filter; the gutter still folds", async ({ page }) => {
  test.slow(); // a body the size of the perf test's
  await showBody(page, FOLD_ALL_LIMIT + 1_000_000);

  await expect(foldAll(page)).toBeDisabled();
  await foldAll(page).hover();
  await expect(page.getByRole("tooltip")).toContainText("filter");
  // Reachable from the keyboard too, and read out as the button's description.
  await page.mouse.move(0, 0);
  await tabTo(page, foldAll(page));
  await expect(page.getByRole("tooltip")).toContainText("filter");
  await expect(foldAll(page)).toHaveAccessibleDescription(/filter/);

  // Neither the key nor the button folds it.
  await editor(page).click();
  await page.keyboard.press("Control+Alt+BracketLeft");
  await expect(page.getByText("Folding…")).toHaveCount(0);
  await expect(placeholders(page)).toHaveCount(0);

  // The first pet's block (line 3), from the fold marker level with it.
  const firstPet = editor(page).locator(".cm-line").nth(2);
  await expect(firstPet).toHaveText("    {");
  const lineY = (await firstPet.boundingBox())!.y;
  const markers = page.locator('.body .cm-foldGutter [title="Fold line"]');
  const ys = await markers.evaluateAll((els) => els.map((e) => e.closest(".cm-gutterElement")!.getBoundingClientRect().y));
  await markers.nth(ys.findIndex((y) => Math.abs(y - lineY) < 2)).click();
  await expect(placeholders(page)).toHaveCount(1);
  await expect(firstPet).toHaveText("    {…},");

  await expect(page.getByRole("button", { name: "Unfold all" })).toBeEnabled();
  await page.getByRole("button", { name: "Unfold all" }).click();
  await expect(placeholders(page)).toHaveCount(0);
});
