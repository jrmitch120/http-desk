// Turning Wrap lines on or off keeps the body's place (#125): the line at the
// top stays at the top, every time, along with the selection and folds, and a
// long line unwrapped scrolls across to where it was being read. The bodies
// are the mock's minified JSON of about a given size (`__mock.preparePerf`),
// whose items repeat, so places are compared by line number, or by enough text
// to tell items apart, rather than by a term.
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";
import { UNWRAP_LIMIT } from "../src/lib/codemirror/longLines";

/** The term only the body's last item has (src/dev/mock.ts `PERF_LAST`). */
const NEAR_THE_END = "needle-near-the-end";

const editor = (page: Page) => page.locator(".body .cm-content");
const wrapped = (page: Page) => page.locator(".body .cm-lineWrapping");
const wrapButton = (page: Page) => page.getByRole("button", { name: "Wrap lines" });
const viewRadio = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Response view" }).getByRole("radio", { name });

/** Sends "List pets", answered with a minified JSON body of about `jsonBytes`, and waits for Pretty. */
async function sendBody(page: Page, jsonBytes: number): Promise<void> {
  await openApp(page);
  await page.evaluate((n) => (window as unknown as { __mock: { preparePerf(jsonBytes: number): void } }).__mock.preparePerf(n), jsonBytes);
  await openRequest(page, ["api", "pets.http"], "List pets");
  await page.keyboard.press("Meta+Enter");
  await expect(editor(page)).toContainText('"items": [');
}

/** Scrolls the body to `f` (0 to 1) of the way down, and waits a few frames for it to settle. */
async function scrollTo(page: Page, f: number): Promise<void> {
  await page.evaluate(async (f) => {
    const s = document.querySelector<HTMLElement>(".body .cm-scroller")!;
    s.scrollTop = f * (s.scrollHeight - s.clientHeight);
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
  }, f);
}

/** The number of the first line at least partly showing at the top of the body. */
function topLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const top = document.querySelector(".body .cm-scroller")!.getBoundingClientRect().top;
    const numbers = [...document.querySelectorAll<HTMLElement>(".body .cm-lineNumbers .cm-gutterElement")].filter((e) => e.style.visibility !== "hidden" && e.textContent);
    const first = numbers.find((e) => e.getBoundingClientRect().bottom > top + 1);
    return Number(first?.textContent ?? NaN);
  });
}

/** The number of the line holding the body's (one) fold placeholder. */
function foldedLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const line = document.querySelector(".body .cm-foldPlaceholder")!.closest(".cm-line")!.getBoundingClientRect();
    const numbers = [...document.querySelectorAll<HTMLElement>(".body .cm-lineNumbers .cm-gutterElement")];
    return Number(numbers.find((e) => Math.abs(e.getBoundingClientRect().top - line.top) < 2)?.textContent ?? NaN);
  });
}

/**
 * The text drawn `around` characters either side of the point in the middle
 * of the body's top row: what the reader sees there ("" if no text is drawn
 * there yet).
 */
function textAtTop(page: Page, around: number): Promise<string> {
  return page.evaluate((around) => {
    const r = document.querySelector(".body .cm-scroller")!.getBoundingClientRect();
    // The first point down from the top on text (unwrapped, below the content's padding).
    let at: Range | null = null;
    let line: Element | null | undefined = null;
    for (let dy = 1; dy <= 12 && !line; dy++) {
      at = document.caretRangeFromPoint(r.left + r.width / 2, r.top + dy);
      line = at?.startContainer.parentElement?.closest(".cm-line");
    }
    // Nothing while CodeMirror still stands in for the text there (a stand-in
    // line, or a gap in a long line rather than its text).
    if (!at || !line || at.startContainer.nodeType !== Node.TEXT_NODE) return "";
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let n = walk.nextNode(); n && n !== at.startContainer; n = walk.nextNode()) offset += n.textContent!.length;
    offset += at.startOffset;
    return line.textContent!.slice(Math.max(0, offset - around), offset + around);
  }, around);
}

/**
 * Turns Wrap lines to `wrap` and waits until that's done: the body is back in
 * place of the one-space stand-in it's laid out with meanwhile, and scrolled.
 */
async function toggleWrap(page: Page, wrap: boolean): Promise<void> {
  await wrapButton(page).click();
  await expect(wrapped(page)).toHaveCount(wrap ? 1 : 0);
  await expect(editor(page)).toHaveText(/\S/);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Toggles Wrap lines, then waits until the body is laid out as `wrap` with line `line` (give or take one) at the top. */
async function toggleKeepsPlace(page: Page, wrap: boolean, line: number): Promise<void> {
  await toggleWrap(page, wrap);
  await expect.poll(async () => Math.abs((await topLine(page)) - line)).toBeLessThanOrEqual(1);
}

for (const startWrapped of [false, true]) {
  const order = startWrapped ? "off, on and off" : "on, off and on";
  test(`turning Wrap lines ${order} keeps the line at the top, every time`, async ({ page }) => {
    await sendBody(page, 100_000);
    if (startWrapped) {
      await toggleWrap(page, true);
    }
    await scrollTo(page, 0.6);
    const line = await topLine(page);
    expect(line).toBeGreaterThan(1000);

    await toggleKeepsPlace(page, !startWrapped, line);
    await toggleKeepsPlace(page, startWrapped, line);
    await toggleKeepsPlace(page, !startWrapped, line);
  });

  test(`the selection and folds survive turning Wrap lines ${startWrapped ? "off and on" : "on and off"}`, async ({ page }) => {
    await sendBody(page, 100_000);
    if (startWrapped) {
      await toggleWrap(page, true);
    }
    await scrollTo(page, 0.6);
    // Fold the first foldable block showing (CodeMirror also draws some lines
    // above the top, and marks blocks foldable only once it has parsed them),
    // and put the cursor a few lines below the fold.
    const markers = page.locator('.body .cm-foldGutter [title="Fold line"]');
    const firstShowingMarker = () =>
      markers.evaluateAll((ms) => {
        const s = document.querySelector(".body .cm-scroller")!.getBoundingClientRect();
        return ms.findIndex((m) => m.getBoundingClientRect().top >= s.top && m.getBoundingClientRect().bottom <= s.bottom);
      });
    await expect.poll(firstShowingMarker).toBeGreaterThanOrEqual(0);
    await markers.nth(await firstShowingMarker()).click();
    const placeholder = page.locator(".body .cm-foldPlaceholder");
    await expect(placeholder).toHaveCount(1);
    const fold = await foldedLine(page);
    expect(fold).toBeGreaterThan(1000);
    const lines = page.locator(".body .cm-line");
    const foldedLineIndex = await lines.evaluateAll((ls) => ls.findIndex((l) => l.querySelector(".cm-foldPlaceholder")));
    await lines.nth(foldedLineIndex + 3).click();
    const active = page.locator(".body .cm-activeLineGutter.cm-gutterElement").first();
    const cursorLine = await active.textContent();
    expect(Number(cursorLine)).toBeGreaterThan(fold);

    for (const wrap of [!startWrapped, startWrapped]) {
      await toggleWrap(page, wrap);
    }
    await expect(placeholder).toHaveCount(1);
    await expect.poll(() => foldedLine(page)).toBe(fold);
    await expect(active).toHaveText(cursorLine!);
  });
}

test("unwrapping a single long line scrolls across to where it was being read", async ({ page }) => {
  await sendBody(page, UNWRAP_LIMIT - 1000);
  await viewRadio(page, "Raw").click();
  await expect(editor(page)).toContainText('{"items":[');
  await toggleWrap(page, true);
  for (let i = 1; i <= 10; i++) await scrollTo(page, i / 10);
  await expect(editor(page)).toContainText(NEAR_THE_END);
  // What's being read in the middle of the top row is there again unwrapped,
  // within 10 characters (the gutter puts the middle of the text a little
  // right of the middle of the body). Scrolled only until it shows, it would
  // be at the right edge, about 30 characters off. The items repeat, so this
  // could only match by chance a whole item away.
  await expect.poll(() => textAtTop(page, 15)).toHaveLength(30);
  const reading = await textAtTop(page, 15);

  await toggleWrap(page, false);
  await expect(editor(page)).toContainText(NEAR_THE_END);
  await expect.poll(() => textAtTop(page, 25)).toContain(reading);
});
