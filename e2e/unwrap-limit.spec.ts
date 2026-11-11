// A body with a line too long for CodeMirror to draw unwrapped is always shown
// wrapped (#119): unwrapped, scrolling across such a line can't reach most of
// it, and at its far right shows nothing. The bodies here are one minified
// line just over or just under the limit (`__mock.preparePerf` overshoots the
// size asked for by at most one item, under 200 characters).
import { expect, test, type Page } from "@playwright/test";
import { openApp, openRequest } from "./helpers";
import { UNWRAP_LIMIT } from "../src/lib/codemirror/unwrap";

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

test("a body with a line over the limit shows wrapped, with Wrap lines turned off and saying why", async ({ page }) => {
  await sendBody(page, UNWRAP_LIMIT + 1000);
  // Pretty's lines are short: unwrapped, as the tab is.
  await expect(wrapButton(page)).toBeEnabled();
  await expect(wrapped(page)).toHaveCount(0);

  await viewRadio(page, "Raw").click();
  await expect(editor(page)).toContainText('{"items":[');
  await expect(wrapped(page)).toHaveCount(1);
  await expect(wrapButton(page)).toBeDisabled();
  await expect(wrapButton(page)).toHaveClass(/active/);
  await wrapButton(page).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Lines too long to unwrap");

  // The tab's own choice (unwrapped) is kept for a view whose lines fit.
  await viewRadio(page, "Pretty").click();
  await expect(editor(page)).toContainText('"items": [');
  await expect(wrapped(page)).toHaveCount(0);
  await expect(wrapButton(page)).toBeEnabled();
  await expect(wrapButton(page)).not.toHaveClass(/active/);
});

test("a body with a line just under the limit shows unwrapped, and scrolls to the line's end", async ({ page }) => {
  await sendBody(page, UNWRAP_LIMIT - 1000);
  await viewRadio(page, "Raw").click();
  await expect(editor(page)).toContainText('{"items":[');
  await expect(wrapped(page)).toHaveCount(0);
  await expect(wrapButton(page)).toBeEnabled();

  // Right in steps, a frame or two each, as a reader would: past the limit, the
  // line's drawn parts and gaps then stop matching the scroll position.
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(async (f) => {
      const s = document.querySelector<HTMLElement>(".body .cm-scroller")!;
      s.scrollLeft = f * (s.scrollWidth - s.clientWidth);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, i / 10);
  }
  await expect(editor(page)).toContainText(NEAR_THE_END);
  await expect(editor(page)).toContainText('"name":"Ann"}}]}');
});
